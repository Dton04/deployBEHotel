// roomRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Room = require("../models/room");
const Booking = require("../models/booking");
const Hotel = require("../models/hotel")
const { protect, admin, restrictRoomManagement } = require("../middleware/auth");
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Tạo thư mục uploads nếu chưa tồn tại
const uploadDir = path.join(__dirname, '../Uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Cấu hình multer với kiểm tra định dạng và kích thước
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

// GET /api/rooms/getallrooms - Lấy tất cả phòng
router.get('/getallrooms', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    const rooms = await Room.find({});
    res.send(rooms);
  } catch (error) {
    console.error("Lỗi khi lấy danh sách phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy danh sách phòng", error: error.message });
  }
});

// POST /api/rooms/getroombyid - Lấy phòng theo ID
router.post("/getroombyid", async (req, res) => {
  const { roomid } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(roomid)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }

    const room = await Room.findById(roomid);

    if (room) {
      res.send(room);
    } else {
      res.status(404).json({ message: "Không tìm thấy phòng" });
    }
  } catch (error) {
    console.error("Lỗi khi lấy thông tin phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy thông tin phòng", error: error.message });
  }
});


// POST /api/rooms - Tạo phòng mới (chỉ admin)
router.post("/", protect, restrictRoomManagement, async (req, res) => {
  const {
    name,
    maxcount,
    beds,
    baths,
    phonenumber,
    rentperday,
    imageurls = [],
    currentbookings = [],
    availabilityStatus = 'available',
    type,
    description,
    hotelId, // Thêm hotelId từ request body
  } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!name || !maxcount || !beds || !baths || !phonenumber || !rentperday || !type || !description || !hotelId) {
      return res.status(400).json({ message: "Vui lòng cung cấp đầy đủ các trường bắt buộc: name, maxcount, beds, baths, phonenumber, rentperday, type, description, hotelId" });
    }

    if (isNaN(maxcount) || isNaN(beds) || isNaN(baths) || isNaN(phonenumber) || isNaN(rentperday)) {
      return res.status(400).json({ message: "maxcount, beds, baths, phonenumber, rentperday phải là số" });
    }

    if (!["available", "maintenance", "busy"].includes(availabilityStatus)) {
      return res.status(400).json({ message: "Trạng thái không hợp lệ. Phải là: available, maintenance, hoặc busy" });
    }

    if (!mongoose.Types.ObjectId.isValid(hotelId)) {
      return res.status(400).json({ message: "ID khách sạn không hợp lệ" });
    }

    // Kiểm tra khách sạn tồn tại
    const hotel = await Hotel.findById(hotelId);
    if (!hotel) {
      return res.status(404).json({ message: "Không tìm thấy khách sạn" });
    }

    const newRoom = new Room({
      name,
      maxcount: Number(maxcount),
      beds: Number(beds),
      baths: Number(baths),
      phonenumber: Number(phonenumber),
      rentperday: Number(rentperday),
      imageurls,
      currentbookings,
      availabilityStatus,
      type,
      description,
    });

    const savedRoom = await newRoom.save();

    // Thêm phòng mới vào mảng rooms của khách sạn
    hotel.rooms.push(savedRoom._id);
    await hotel.save();

    res.status(201).json({
      message: "Tạo phòng thành công",
      room: {
        _id: savedRoom._id,
        name: savedRoom.name,
        maxcount: savedRoom.maxcount,
        beds: savedRoom.beds,
        baths: savedRoom.baths,
        phonenumber: savedRoom.phonenumber,
        rentperday: savedRoom.rentperday,
        imageurls: savedRoom.imageurls,
        currentbookings: savedRoom.currentbookings,
        availabilityStatus: savedRoom.availabilityStatus,
        type: savedRoom.type,
        description: savedRoom.description,
        createdAt: savedRoom.createdAt,
        updatedAt: savedRoom.updatedAt,
      },
    });
  } catch (error) {
    console.error("Lỗi khi tạo phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi tạo phòng", error: error.message });
  }
});

// POST /api/rooms/:id/availability - Cập nhật trạng thái phòng
router.post("/:id/availability", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }

    if (!["available", "maintenance", "busy"].includes(status)) {
      return res.status(400).json({ message: "Trạng thái không hợp lệ. Phải là: available, maintenance, hoặc busy" });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: "Không tìm thấy phòng với ID này" });
    }

    room.availabilityStatus = status;
    await room.save();

    res.status(200).json({ message: `Cập nhật trạng thái phòng thành ${status} thành công`, room });
  } catch (error) {
    console.error("Lỗi khi cập nhật trạng thái phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi cập nhật trạng thái phòng", error: error.message });
  }
});

// GET /api/rooms/available - Lấy danh sách phòng trống
router.get("/available", async (req, res) => {
  const { checkin, checkout } = req.query;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!checkin || !checkout) {
      return res.status(400).json({ message: "checkin và checkout là bắt buộc" });
    }

    const checkinDate = new Date(checkin);
    const checkoutDate = new Date(checkout);
    if (isNaN(checkinDate.getTime()) || isNaN(checkoutDate.getTime())) {
      return res.status(400).json({ message: "Ngày nhận phòng hoặc trả phòng không hợp lệ" });
    }

    if (checkinDate >= checkoutDate) {
      return res.status(400).json({ message: "Ngày nhận phòng phải trước ngày trả phòng" });
    }

    const rooms = await Room.find({
      availabilityStatus: 'available',
    });

    const availableRooms = rooms.filter(room => {
      return !room.currentbookings.some(booking => {
        const existingCheckin = new Date(booking.checkin);
        const existingCheckout = new Date(booking.checkout);
        return (
          (checkinDate >= existingCheckin && checkinDate < existingCheckout) ||
          (checkoutDate > existingCheckin && checkoutDate <= existingCheckout) ||
          (checkinDate <= existingCheckin && checkoutDate >= existingCheckout)
        );
      });
    });

    res.status(200).json(availableRooms);
  } catch (error) {
    console.error("Lỗi khi kiểm tra phòng còn trống:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi kiểm tra phòng còn trống", error: error.message });
  }
});

// GET /api/rooms/suggestions - Lấy danh sách phòng gợi ý
router.get("/suggestions", async (req, res) => {
  const { roomId, roomType, checkin, checkout, limit } = req.query;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(roomId)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }

    if (!roomType) {
      return res.status(400).json({ message: "Loại phòng là bắt buộc" });
    }

    const typeExists = await Room.exists({ type: roomType });
    if (!typeExists) {
      return res.status(400).json({ message: `Không tìm thấy phòng với loại '${roomType}'` });
    }

    let checkinDate, checkoutDate;
    if (checkin && checkout) {
      checkinDate = new Date(checkin);
      checkoutDate = new Date(checkout);
      if (isNaN(checkinDate.getTime()) || isNaN(checkoutDate.getTime())) {
        return res.status(400).json({ message: "Ngày nhận phòng hoặc trả phòng không hợp lệ" });
      }
      if (checkinDate >= checkoutDate) {
        return res.status(400).json({ message: "Ngày nhận phòng phải trước ngày trả phòng" });
      }
    }

    const maxLimit = parseInt(limit) || 3;
    const finalLimit = Math.min(maxLimit, 10);

    const query = {
      _id: { $ne: roomId },
      type: roomType,
      availabilityStatus: 'available',
    };

    let suggestions = await Room.find(query)
      .sort({ rentperday: 1 })
      .limit(finalLimit)
      .select('_id name type rentperday imageurls availabilityStatus');

    if (checkin && checkout) {
      suggestions = suggestions.filter(room => {
        return !room.currentbookings.some(booking => {
          const existingCheckin = new Date(booking.checkin);
          const existingCheckout = new Date(booking.checkout);
          return (
            (checkinDate >= existingCheckin && checkinDate < existingCheckout) ||
            (checkoutDate > existingCheckin && checkoutDate <= existingCheckout) ||
            (checkinDate <= existingCheckin && checkoutDate >= existingCheckout)
          );
        });
      });
    }

    if (suggestions.length === 0) {
      return res.status(200).json([]);
    }

    res.status(200).json(suggestions);
  } catch (error) {
    console.error("Lỗi khi lấy phòng gợi ý:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy phòng gợi ý", error: error.message });
  }
});

// BE4.14 PUT /api/rooms/:id - Cập nhật thông tin phòng
router.put("/:id", protect, restrictRoomManagement, async (req, res) => {
  const { id } = req.params;
  const {
    name,
    maxcount,
    beds,
    baths,
    phonenumber,
    rentperday,
    imageurls,
    availabilityStatus,
    type,
    description,
    hotelId, // Thêm hotelId từ request body
  } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }

    if (!name || !maxcount || !beds || !baths || !phonenumber || !rentperday || !type || !description || !hotelId) {
      return res.status(400).json({ message: "Vui lòng cung cấp đầy đủ các trường bắt buộc: name, maxcount, beds, baths, phonenumber, rentperday, type, description, hotelId" });
    }

    if (isNaN(maxcount) || isNaN(beds) || isNaN(baths) || isNaN(phonenumber) || isNaN(rentperday)) {
      return res.status(400).json({ message: "maxcount, beds, baths, phonenumber, rentperday phải là số" });
    }

    if (!["available", "maintenance", "busy"].includes(availabilityStatus)) {
      return res.status(400).json({ message: "Trạng thái không hợp lệ. Phải là: available, maintenance, hoặc busy" });
    }

    if (!mongoose.Types.ObjectId.isValid(hotelId)) {
      return res.status(400).json({ message: "ID khách sạn không hợp lệ" });
    }

    const hotel = await Hotel.findById(hotelId);
    if (!hotel) {
      return res.status(404).json({ message: "Không tìm thấy khách sạn" });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: "Không tìm thấy phòng" });
    }

    room.name = name;
    room.maxcount = Number(maxcount);
    room.beds = Number(beds);
    room.baths = Number(baths);
    room.phonenumber = Number(phonenumber);
    room.rentperday = Number(rentperday);
    room.imageurls = imageurls || [];
    room.availabilityStatus = availabilityStatus;
    room.type = type;
    room.description = description;

    const updatedRoom = await room.save();

    // Đảm bảo phòng vẫn nằm trong mảng rooms của khách sạn
    if (!hotel.rooms.includes(id)) {
      hotel.rooms.push(id);
      await hotel.save();
    }

    res.status(200).json({ message: "Cập nhật phòng thành công", room: updatedRoom });
  } catch (error) {
    console.error("Lỗi khi cập nhật phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi cập nhật phòng", error: error.message });
  }
});

// BE4.15 DELETE /api/rooms/:id - Xóa phòng
router.delete("/:id", protect, restrictRoomManagement, async (req, res) => {
  const { id } = req.params;
  const { hotelId } = req.query; // Lấy hotelId từ query params

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }

    if (!mongoose.Types.ObjectId.isValid(hotelId)) {
      return res.status(400).json({ message: "ID khách sạn không hợp lệ" });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: "Không tìm thấy phòng" });
    }

    // Kiểm tra xem phòng có đặt phòng đang hoạt động không
    const activeBookings = await Booking.find({
      roomid: id,
      status: { $in: ["pending", "confirmed"] },
    });

    if (activeBookings.length > 0) {
      return res.status(400).json({ message: "Không thể xóa phòng vì vẫn còn đặt phòng đang hoạt động" });
    }

    // Xóa phòng khỏi mảng rooms của khách sạn
    const hotel = await Hotel.findById(hotelId);
    if (hotel) {
      hotel.rooms = hotel.rooms.filter((roomId) => roomId.toString() !== id);
      await hotel.save();
    }

    await Room.deleteOne({ _id: id });
    res.status(200).json({ message: "Xóa phòng thành công" });
  } catch (error) {
    console.error("Lỗi khi xóa phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi xóa phòng", error: error.message });
  }
});

// BE4.16 PATCH /api/rooms/:id/maintenance - Chuyển trạng thái phòng sang bảo trì
router.patch("/:id/maintenance", protect, restrictRoomManagement, async (req, res) => {
  const { id } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: "Không tìm thấy phòng" });
    }

    // Kiểm tra xem phòng có đặt phòng đang hoạt động không
    const activeBookings = await Booking.find({
      roomid: id,
      status: { $in: ["pending"] }
    });

    if (activeBookings.length > 0) {
      return res.status(400).json({ message: "Không thể chuyển sang trạng thái bảo trì vì vẫn còn đặt phòng đang hoạt động" });
    }

    room.availabilityStatus = "maintenance";
    const updatedRoom = await room.save();

    res.status(200).json({ message: "Chuyển trạng thái phòng sang bảo trì thành công", room: updatedRoom });
  } catch (error) {
    console.error("Lỗi khi chuyển trạng thái phòng sang bảo trì:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi chuyển trạng thái phòng sang bảo trì", error: error.message });
  }
});

// BE4.17 GET /api/rooms/summary - Thống kê trạng thái phòng
router.get("/summary", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    const summary = await Room.aggregate([
      { $group: { _id: "$availabilityStatus", count: { $sum: 1 } } }
    ]);

    const result = { available: 0, maintenance: 0, busy: 0 };
    summary.forEach(item => { result[item._id] = item.count; });

    res.status(200).json(result);
  } catch (error) {
    console.error("Lỗi khi lấy thống kê trạng thái phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy thống kê trạng thái phòng", error: error.message });
  }
});

// BE4.18 GET /api/rooms/similar/:id - Trả về danh sách phòng tương tự
router.get("/similar/:id", async (req, res) => {
  const { id } = req.params;
  const { limit = 3 } = req.query;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: "Không tìm thấy phòng" });
    }

    const maxLimit = parseInt(limit) || 3;
    const finalLimit = Math.min(maxLimit, 10);

    const similarRooms = await Room.find({
      _id: { $ne: id },
      type: room.type,
      availabilityStatus: 'available'
    })
      .sort({ rentperday: 1 })
      .limit(finalLimit)
      .select('_id name type rentperday imageurls availabilityStatus');

    res.status(200).json(similarRooms);
  } catch (error) {
    console.error("Lỗi khi lấy danh sách phòng tương tự:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy danh sách phòng tương tự", error: error.message });
  }
});

// BE4.19 GET /api/rooms/popular - Phòng được đặt nhiều nhất
router.get("/popular", async (req, res) => {
  const { limit = 5 } = req.query;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    const maxLimit = parseInt(limit) || 5;
    const finalLimit = Math.min(maxLimit, 10);

    const popularRooms = await Booking.aggregate([
      { $match: { status: { $in: ["confirmed", "pending"] } } },
      { $group: { _id: "$roomid", bookingCount: { $sum: 1 } } },
      { $sort: { bookingCount: -1 } },
      { $limit: finalLimit },
      {
        $lookup: {
          from: "rooms",
          localField: "_id",
          foreignField: "_id",
          as: "room"
        }
      },
      { $unwind: "$room" },
      {
        $project: {
          _id: "$room._id",
          name: "$room.name",
          type: "$room.type",
          rentperday: "$room.rentperday",
          imageurls: "$room.imageurls",
          availabilityStatus: "$room.availabilityStatus",
          bookingCount: 1
        }
      }
    ]);

    res.status(200).json(popularRooms);
  } catch (error) {
    console.error("Lỗi khi lấy danh sách phòng phổ biến:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy danh sách phòng phổ biến", error: error.message });
  }
});

// BE4.20 PATCH /api/rooms/:id/price - Cập nhật giá phòng
router.patch("/:id/price", protect, restrictRoomManagement, async (req, res) => {
  const { id } = req.params;
  const { rentperday } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }

    if (!rentperday || isNaN(rentperday) || Number(rentperday) <= 0) {
      return res.status(400).json({ message: "Giá phòng phải là số dương" });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: "Không tìm thấy phòng" });
    }

    room.rentperday = Number(rentperday);
    const updatedRoom = await room.save();

    res.status(200).json({ message: "Cập nhật giá phòng thành công", room: updatedRoom });
  } catch (error) {
    console.error("Lỗi khi cập nhật giá phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi cập nhật giá phòng", error: error.message });
  }
});

// BE4.21 POST /api/rooms/:id/images - Tải ảnh phòng
router.post("/:id/images", protect, restrictRoomManagement, upload.array('images', 5), async (req, res) => {
  const { id } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: "Không tìm thấy phòng" });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "Vui lòng cung cấp ít nhất một ảnh" });
    }

    const newImages = req.files.map(file => `${req.protocol}://${req.get('host')}/Uploads/${file.filename}`);
    room.imageurls = [...room.imageurls, ...newImages];
    const updatedRoom = await room.save();

    res.status(201).json({ message: "Tải ảnh phòng thành công", room: updatedRoom });
  } catch (error) {
    console.error("Lỗi khi tải ảnh phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi tải ảnh phòng", error: error.message });
  }
});

// BE4.22 DELETE /api/rooms/:id/images/:imgId - Xóa ảnh phòng
router.delete("/:id/images/:imgId", protect, restrictRoomManagement, async (req, res) => {
  const { id, imgId } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: "Không tìm thấy phòng" });
    }

    const imageIndex = room.imageurls.findIndex(url => url.includes(imgId));
    if (imageIndex === -1) {
      return res.status(404).json({ message: "Không tìm thấy ảnh" });
    }

    const imageUrl = room.imageurls[imageIndex];
    const filePath = path.join(__dirname, '../', imageUrl.replace(`${req.protocol}://${req.get('host')}`, ''));
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    room.imageurls.splice(imageIndex, 1);
    const updatedRoom = await room.save();

    res.status(200).json({ message: "Xóa ảnh phòng thành công", room: updatedRoom });
  } catch (error) {
    console.error("Lỗi khi xóa ảnh phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi xóa ảnh phòng", error: error.message });
  }
});

// BE4.23 GET /api/rooms/images/:id - Lấy danh sách ảnh của phòng
router.get("/images/:id", async (req, res) => {
  const { id } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }

    const room = await Room.findById(id).select('imageurls');
    if (!room) {
      return res.status(404).json({ message: "Không tìm thấy phòng" });
    }

    res.status(200).json({ images: room.imageurls });
  } catch (error) {
    console.error("Lỗi khi lấy danh sách ảnh phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy danh sách ảnh phòng", error: error.message });
  }
});

module.exports = router;