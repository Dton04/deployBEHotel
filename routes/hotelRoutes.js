const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Hotel = require('../models/hotel');
const Room = require('../models/room');
const Region = require('../models/region');
const Booking = require('../models/booking');
const { protect, admin } = require('../middleware/auth');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Tạo thư mục uploads nếu chưa tồn tại
const uploadDir = path.join(__dirname, '../Uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Cấu hình multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'Uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Chỉ chấp nhận file JPEG, PNG hoặc GIF'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // Giới hạn 5MB
});

// GET /api/hotels/:id - Lấy chi tiết khách sạn
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'ID khách sạn không hợp lệ' });
    }

    const hotel = await Hotel.findById(id)
      .populate('region', 'name')
      .populate('rooms', '_id name maxcount beds baths rentperday type description imageurls availabilityStatus currentbookings');
    
    if (!hotel) {
      return res.status(404).json({ message: 'Không tìm thấy khách sạn' });
    }

    res.status(200).json({
      hotel: {
        _id: hotel._id,
        name: hotel.name,
        address: hotel.address,
        region: hotel.region,
        contactNumber: hotel.contactNumber,
        email: hotel.email,
        description: hotel.description,
        imageurls: hotel.imageurls,
        rooms: hotel.rooms,
        createdAt: hotel.createdAt,
        updatedAt: hotel.updatedAt,
      }
    });
  } catch (error) {
    console.error('Lỗi khi lấy chi tiết khách sạn:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi lấy chi tiết khách sạn', error: error.message });
  }
});

// POST /api/hotels/:id/images - Tải ảnh khách sạn
router.post('/:id/images', protect, admin, upload.array('images', 5), async (req, res) => {
  const { id } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'ID khách sạn không hợp lệ' });
    }

    const hotel = await Hotel.findById(id);
    if (!hotel) {
      return res.status(404).json({ message: 'Không tìm thấy khách sạn' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'Vui lòng cung cấp ít nhất một ảnh' });
    }

    const newImages = req.files.map(file => `${req.protocol}://${req.get('host')}/Uploads/${file.filename}`);
    hotel.imageurls = [...(hotel.imageurls || []), ...newImages];
    const updatedHotel = await hotel.save();

    res.status(201).json({ message: 'Tải ảnh khách sạn thành công', hotel: updatedHotel });
  } catch (error) {
    console.error('Lỗi khi tải ảnh khách sạn:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi tải ảnh khách sạn', error: error.message });
  }
});

// DELETE /api/hotels/:id/images/:imgId - Xóa ảnh khách sạn
router.delete('/:id/images/:imgId', protect, admin, async (req, res) => {
  const { id, imgId } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'ID khách sạn không hợp lệ' });
    }

    const hotel = await Hotel.findById(id);
    if (!hotel) {
      return res.status(404).json({ message: 'Không tìm thấy khách sạn' });
    }

    const imageIndex = hotel.imageurls.findIndex(url => url.includes(imgId));
    if (imageIndex === -1) {
      return res.status(404).json({ message: 'Không tìm thấy ảnh' });
    }

    const imageUrl = hotel.imageurls[imageIndex];
    const filePath = path.join(__dirname, '../', imageUrl.replace(`${req.protocol}://${req.get('host')}`, ''));
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    hotel.imageurls.splice(imageIndex, 1);
    const updatedHotel = await hotel.save();

    res.status(200).json({ message: 'Xóa ảnh khách sạn thành công', hotel: updatedHotel });
  } catch (error) {
    console.error('Lỗi khi xóa ảnh khách sạn:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi xóa ảnh khách sạn', error: error.message });
  }
});

// GET /api/hotels - Lấy danh sách khách sạn và tất cả phòng
router.get('/', async (req, res) => {
  const { checkin, checkout, adults, children, roomType } = req.query;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    if (!checkin || !checkout) {
      const hotels = await Hotel.find().populate('region').populate('rooms');
      return res.status(200).json(hotels);
    }

    const checkinDate = new Date(checkin);
    const checkoutDate = new Date(checkout);
    const totalGuests = Number(adults) + Number(children || 0);

    if (isNaN(checkinDate.getTime()) || isNaN(checkoutDate.getTime())) {
      return res.status(400).json({ message: 'Ngày nhận phòng hoặc trả phòng không hợp lệ' });
    }

    if (checkinDate >= checkoutDate) {
      return res.status(400).json({ message: 'Ngày nhận phòng phải trước ngày trả phòng' });
    }

    if (isNaN(totalGuests) || totalGuests < 1) {
      return res.status(400).json({ message: 'Số lượng khách không hợp lệ' });
    }

    const hotels = await Hotel.find().populate('region');

    const filteredHotels = await Promise.all(
      hotels.map(async (hotel) => {
        const hotelWithRooms = await Hotel.findById(hotel._id).populate({
          path: 'rooms',
          match: {
            maxcount: { $gte: totalGuests },
            ...(roomType && { type: roomType }),
          },
          select: '_id name maxcount beds baths rentperday type description imageurls currentbookings availabilityStatus',
        });

        if (!hotelWithRooms || !hotelWithRooms.rooms.length) return null;

        const roomsWithStatus = hotelWithRooms.rooms.map((room) => {
          let status = room.availabilityStatus;
          if (status === 'available') {
            const isBooked = room.currentbookings.some((booking) => {
              const existingCheckin = new Date(booking.checkin);
              const existingCheckout = new Date(booking.checkout);
              return (
                (checkinDate >= existingCheckin && checkinDate < existingCheckout) ||
                (checkoutDate > existingCheckin && checkoutDate <= existingCheckout) ||
                (checkinDate <= existingCheckin && checkoutDate >= existingCheckout)
              );
            });
            status = isBooked ? 'booked' : 'available';
          }
          return {
            ...room.toObject(),
            status,
          };
        });

        if (roomsWithStatus.length === 0) return null;

        return {
          ...hotel.toObject(),
          rooms: roomsWithStatus,
        };
      })
    );

    const validHotels = filteredHotels.filter((hotel) => hotel !== null);

    res.status(200).json(validHotels);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách khách sạn:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi lấy danh sách khách sạn', error: error.message });
  }
});

// GET /api/hotels/:id/rooms - Lấy danh sách phòng của khách sạn
router.get('/:id/rooms', async (req, res) => {
  const { id } = req.params;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'ID khách sạn không hợp lệ' });
    }

    const hotel = await Hotel.findById(id)
      .populate('rooms')
      .populate('region', 'name');
    if (!hotel) {
      return res.status(404).json({ message: 'Không tìm thấy khách sạn' });
    }

    res.status(200).json({
      hotel: {
        _id: hotel._id,
        name: hotel.name,
        address: hotel.address,
        region: hotel.region,
        imageurls: hotel.imageurls,
      },
      rooms: hotel.rooms,
    });
  } catch (error) {
    console.error('Lỗi khi lấy danh sách phòng:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi lấy danh sách phòng', error: error.message });
  }
});

// GET /api/hotels/:id/available-rooms - Lấy danh sách phòng trống
router.get('/:id/available-rooms', async (req, res) => {
  const { id } = req.params;
  const { checkin, checkout } = req.query;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'ID khách sạn không hợp lệ' });
    }

    if (!checkin || !checkout) {
      return res.status(400).json({ message: 'checkin và checkout là bắt buộc' });
    }

    const checkinDate = new Date(checkin);
    const checkoutDate = new Date(checkout);
    if (isNaN(checkinDate.getTime()) || isNaN(checkoutDate.getTime())) {
      return res.status(400).json({ message: 'Ngày nhận phòng hoặc trả phòng không hợp lệ' });
    }

    if (checkinDate >= checkoutDate) {
      return res.status(400).json({ message: 'Ngày nhận phòng phải trước ngày trả phòng' });
    }

    const hotel = await Hotel.findById(id).populate({
      path: 'rooms',
      match: { availabilityStatus: 'available' },
      select: '_id name maxcount beds baths rentperday type description imageurls currentbookings',
    });

    if (!hotel) {
      return res.status(404).json({ message: 'Không tìm thấy khách sạn' });
    }

    const availableRooms = hotel.rooms.filter((room) => {
      return !room.currentbookings.some((booking) => {
        const existingCheckin = new Date(booking.checkin);
        const existingCheckout = new Date(booking.checkout);
        return (
          (checkinDate >= existingCheckin && checkinDate < existingCheckout) ||
          (checkoutDate > existingCheckin && checkoutDate <= existingCheckout) ||
          (checkinDate <= existingCheckin && checkoutDate >= existingCheckout)
        );
      });
    });

    res.status(200).json({
      message: 'Danh sách phòng trống',
      hotel: hotel.name,
      rooms: availableRooms,
    });
  } catch (error) {
    console.error('Lỗi khi kiểm tra phòng trống:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi kiểm tra phòng trống', error: error.message });
  }
});

// POST /api/hotels - Thêm khách sạn mới
router.post('/', protect, admin, async (req, res) => {
  const { name, address, region, contactNumber, email, description, rooms } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    if (!name || !address || !region || !contactNumber || !email) {
      return res.status(400).json({
        message: 'Vui lòng cung cấp đầy đủ các trường bắt buộc: name, address, region, contactNumber, email',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(region)) {
      return res.status(400).json({ message: 'ID khu vực không hợp lệ' });
    }

    const regionExists = await Region.findById(region);
    if (!regionExists) {
      return res.status(404).json({ message: 'Không tìm thấy khu vực' });
    }

    if (rooms && rooms.length > 0) {
      const validRooms = await Room.find({ _id: { $in: rooms } });
      if (validRooms.length !== rooms.length) {
        return res.status(400).json({ message: 'Một hoặc nhiều phòng không tồn tại' });
      }
    }

    const hotelExists = await Hotel.findOne({ name });
    if (hotelExists) {
      return res.status(400).json({ message: 'Tên khách sạn đã tồn tại' });
    }

    const hotel = new Hotel({
      name,
      address,
      region,
      contactNumber,
      email,
      description,
      rooms: rooms || [],
    });

    const savedHotel = await hotel.save();
    res.status(201).json({ message: 'Tạo khách sạn thành công', hotel: savedHotel });
  } catch (error) {
    console.error('Lỗi khi tạo khách sạn:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi tạo khách sạn', error: error.message });
  }
});

// PUT /api/hotels/:id - Cập nhật thông tin khách sạn
router.put('/:id', protect, admin, async (req, res) => {
  const { id } = req.params;
  const { name, address, region, contactNumber, email, description, rooms } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'ID khách sạn không hợp lệ' });
    }

    if (!name || !address || !region || !contactNumber || !email) {
      return res.status(400).json({
        message: 'Vui lòng cung cấp đầy đủ các trường bắt buộc: name, address, region, contactNumber, email',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(region)) {
      return res.status(400).json({ message: 'ID khu vực không hợp lệ' });
    }

    const regionExists = await Region.findById(region);
    if (!regionExists) {
      return res.status(404).json({ message: 'Không tìm thấy khu vực' });
    }

    if (rooms && rooms.length > 0) {
      const validRooms = await Room.find({ _id: { $in: rooms } });
      if (validRooms.length !== rooms.length) {
        return res.status(400).json({ message: 'Một hoặc nhiều phòng không tồn tại' });
      }
    }

    const hotel = await Hotel.findById(id);
    if (!hotel) {
      return res.status(404).json({ message: 'Không tìm thấy khách sạn' });
    }

    hotel.name = name;
    hotel.address = address;
    hotel.region = region;
    hotel.contactNumber = contactNumber;
    hotel.email = email;
    hotel.description = description || hotel.description;
    hotel.rooms = rooms || hotel.rooms;

    const updatedHotel = await hotel.save();
    res.status(200).json({ message: 'Cập nhật khách sạn thành công', hotel: updatedHotel });
  } catch (error) {
    console.error('Lỗi khi cập nhật khách sạn:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi cập nhật khách sạn', error: error.message });
  }
});

// DELETE /api/hotels/:id - Xóa khách sạn
router.delete('/:id', protect, admin, async (req, res) => {
  const { id } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'ID khách sạn không hợp lệ' });
    }

    const hotel = await Hotel.findById(id);
    if (!hotel) {
      return res.status(404).json({ message: 'Không tìm thấy khách sạn' });
    }

    const activeBookings = await Booking.find({
      roomid: { $in: hotel.rooms },
      status: { $in: ['pending', 'confirmed'] },
    });

    if (activeBookings.length > 0) {
      return res.status(400).json({ message: 'Không thể xóa khách sạn vì vẫn còn đặt phòng đang hoạt động' });
    }

    await Hotel.deleteOne({ _id: id });
    res.status(200).json({ message: 'Xóa khách sạn thành công' });
  } catch (error) {
    console.error('Lỗi khi xóa khách sạn:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi xóa khách sạn', error: error.message });
  }
});

// POST /api/hotels/region - Phân vùng khu vực quản lý
router.post('/region', protect, admin, async (req, res) => {
  const { hotelId, regionId } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    if (!mongoose.Types.ObjectId.isValid(hotelId) || !mongoose.Types.ObjectId.isValid(regionId)) {
      return res.status(400).json({ message: 'ID khách sạn hoặc khu vực không hợp lệ' });
    }

    const hotel = await Hotel.findById(hotelId);
    if (!hotel) {
      return res.status(404).json({ message: 'Không tìm thấy khách sạn' });
    }

    const region = await Region.findById(regionId);
    if (!region) {
      return res.status(404).json({ message: 'Không tìm thấy khu vực' });
    }

    hotel.region = regionId;
    await hotel.save();

    res.status(200).json({ message: 'Gán khu vực quản lý cho khách sạn thành công', hotel });
  } catch (error) {
    console.error('Lỗi khi gán khu vực quản lý:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi gán khu vực quản lý', error: error.message });
  }
});

module.exports = router;