const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Review = require("../models/review");
const Booking = require("../models/booking");
const Hotel = require("../models/hotel");
const { protect, admin, staff } = require('../middleware/auth');

// Middleware kiểm tra admin hoặc staff
const adminOrStaff = (req, res, next) => {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'staff')) {
    next();
  } else {
    res.status(403).json({ message: 'Không được phép, yêu cầu quyền admin hoặc staff' });
  }
};

// POST /api/reviews – Gửi đánh giá mới
router.post("/", async (req, res) => {
  const { hotelId, roomId, userName, rating, comment, email } = req.body;

  try {
    console.log("Request body:", req.body);

    // Kiểm tra kết nối database
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    // Kiểm tra dữ liệu đầu vào
    if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
      return res.status(400).json({ message: "ID khách sạn không hợp lệ hoặc thiếu" });
    }
    if (roomId && !mongoose.Types.ObjectId.isValid(roomId)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Điểm đánh giá phải từ 1 đến 5" });
    }
    if (!comment || comment.trim() === "") {
      return res.status(400).json({ message: "Bình luận là bắt buộc" });
    }
    if (!email || email.trim() === "") {
      return res.status(400).json({ message: "Email là bắt buộc để gửi đánh giá" });
    }

    // Kiểm tra khách sạn tồn tại
    const hotel = await Hotel.findById(hotelId).populate('rooms');
    if (!hotel) {
      return res.status(404).json({ message: "Không tìm thấy khách sạn" });
    }

    // Kiểm tra roomId thuộc khách sạn (nếu có)
    if (roomId) {
      const roomExists = hotel.rooms.some(room => room._id.toString() === roomId);
      if (!roomExists) {
        return res.status(400).json({ message: "Phòng không thuộc khách sạn này" });
      }
    }

    // Kiểm tra mảng hotel.rooms hợp lệ
    const validRoomIds = hotel.rooms
      .filter(room => mongoose.Types.ObjectId.isValid(room._id))
      .map(room => room._id);
    if (validRoomIds.length === 0) {
      return res.status(400).json({ message: "Khách sạn không có phòng hợp lệ để kiểm tra đặt phòng" });
    }

    // Kiểm tra đặt phòng và trạng thái thanh toán
    console.log("Checking booking for email:", email, "and hotelId:", hotelId);
    const bookingQuery = { 
      email: email.toLowerCase(), 
      roomid: { $in: validRoomIds },
      paymentStatus: "paid",
      status: "confirmed"
    };
    if (roomId) {
      bookingQuery.roomid = roomId;
    }
    const booking = await Booking.findOne(bookingQuery);
    if (!booking) {
      return res.status(403).json({ 
        message: "Bạn phải có đặt phòng đã thanh toán thành công trong khách sạn này để gửi đánh giá" 
      });
    }

    // Kiểm tra đánh giá đã tồn tại
    console.log("Checking existing review for hotelId:", hotelId, "and email:", email);
    const existingReviewQuery = { hotelId, email: email.toLowerCase(), isDeleted: false };
    if (roomId) {
      existingReviewQuery.roomId = roomId;
    }
    const existingReview = await Review.findOne(existingReviewQuery);
    if (existingReview) {
      return res.status(403).json({ message: "Bạn đã gửi đánh giá cho khách sạn/phòng này rồi" });
    }

    // Tạo và lưu đánh giá mới
    const newReview = new Review({
      hotelId,
      roomId: roomId || null,
      userName: userName || "Ẩn danh",
      rating: parseInt(rating, 10),
      comment,
      email: email.toLowerCase(),
      bookingId: booking._id,
    });

    console.log("Saving new review:", newReview);
    await newReview.save();

    res.status(201).json({ message: "Gửi đánh giá thành công", review: newReview });
  } catch (error) {
    console.error("Lỗi khi gửi đánh giá:", {
      message: error.message,
      stack: error.stack,
      requestBody: req.body,
    });
    res.status(500).json({ message: "Lỗi khi gửi đánh giá", error: error.message });
  }
});

// GET /api/reviews - Lấy danh sách đánh giá với bộ lọc và phân trang
router.get("/", async (req, res) => {
  const { hotelId, roomId, email, status, page = 1, limit = 10 } = req.query;

  try {
    const query = {};

    if (hotelId) {
      if (!mongoose.Types.ObjectId.isValid(hotelId)) {
        return res.status(400).json({ message: "ID khách sạn không hợp lệ" });
      }
      query.hotelId = hotelId;
    }

    if (roomId) {
      if (!mongoose.Types.ObjectId.isValid(roomId)) {
        return res.status(400).json({ message: "ID phòng không hợp lệ" });
      }
      query.roomId = roomId;
    }

    if (email) {
      query.email = email.toLowerCase();
    }

    if (status) {
      if (status === "active") {
        query.isDeleted = false;
        query.isVisible = true;
      } else if (status === "hidden") {
        query.isDeleted = false;
        query.isVisible = false;
      } else if (status === "deleted") {
        query.isDeleted = true;
      } else {
        return res.status(400).json({ message: "Trạng thái không hợp lệ, chỉ chấp nhận 'active', 'hidden', hoặc 'deleted'" });
      }
    } else {
      query.isDeleted = false;
      query.isVisible = true;
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    const parsedPage = parseInt(page);
    const parsedLimit = parseInt(limit);

    if (isNaN(parsedPage) || parsedPage < 1 || isNaN(parsedLimit) || parsedLimit < 1) {
      return res.status(400).json({ message: "Trang và giới hạn phải là số nguyên dương" });
    }

    const totalReviews = await Review.countDocuments(query);
    const reviews = await Review.find(query)
      .populate("hotelId", "name")
      .populate("roomId", "name type")
      .sort({ createdAt: -1 })
      .skip((parsedPage - 1) * parsedLimit)
      .limit(parsedLimit);

    res.status(200).json({
      reviews,
      totalReviews,
      totalPages: Math.ceil(totalReviews / parsedLimit),
      currentPage: parsedPage,
    });
  } catch (error) {
    console.error("Lỗi khi lấy danh sách đánh giá:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy danh sách đánh giá", error: error.message });
  }
});

// GET /api/reviews/average?hotelId=...
router.get("/average", async (req, res) => {
  const { hotelId } = req.query;

  try {
    if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
      return res.status(400).json({ message: "ID khách sạn không hợp lệ hoặc thiếu" });
    }

    const reviews = await Review.find({ hotelId, isDeleted: false, isVisible: true });
    const totalReviews = reviews.length;
    const average = totalReviews > 0 ? reviews.reduce((sum, review) => sum + review.rating, 0) / totalReviews : 0;

    res.status(200).json({ average, totalReviews });
  } catch (error) {
    console.error("Lỗi khi tính điểm trung bình:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi tính điểm trung bình", error: error.message });
  }
});

// GET /api/reviews/by-email?email=...
router.get("/by-email", async (req, res) => {
  const { email } = req.query;

  try {
    if (!email || email.trim() === "") {
      return res.status(400).json({ message: "Email là bắt buộc" });
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    const reviews = await Review.find({ email: email.toLowerCase(), isDeleted: false, isVisible: true })
      .populate("hotelId", "name")
      .populate("roomId", "name type");
    res.status(200).json(reviews);
  } catch (error) {
    console.error("Lỗi khi lấy danh sách đánh giá theo email:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy danh sách đánh giá theo email", error: error.message });
  }
});

// PATCH /api/reviews/:id/toggle-hidden - Ẩn/hiển thị đánh giá
router.patch("/:id/toggle-hidden", protect, adminOrStaff, async (req, res) => {
  const { id } = req.params;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID đánh giá không hợp lệ" });
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    const review = await Review.findById(id);
    if (!review) {
      return res.status(404).json({ message: "Không tìm thấy đánh giá với ID này" });
    }

    if (review.isDeleted) {
      return res.status(400).json({ message: "Không thể thay đổi trạng thái ẩn của đánh giá đã bị xóa" });
    }

    review.isVisible = !review.isVisible;
    await review.save();

    const message = review.isVisible ? "Hiển thị đánh giá thành công" : "Ẩn đánh giá thành công";
    res.status(200).json({ message, review });
  } catch (error) {
    console.error("Lỗi khi thay đổi trạng thái ẩn của đánh giá:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi thay đổi trạng thái ẩn của đánh giá", error: error.message });
  }
});

// DELETE /api/reviews/:id - Xóa mềm đánh giá
router.delete("/:id", protect, adminOrStaff, async (req, res) => {
  const { id } = req.params;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID đánh giá không hợp lệ" });
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    const review = await Review.findById(id);
    if (!review) {
      return res.status(404).json({ message: "Không tìm thấy đánh giá với ID này" });
    }

    if (review.isDeleted) {
      return res.status(400).json({ message: "Đánh giá này đã bị xóa trước đó" });
    }

    review.isDeleted = true;
    await review.save();

    res.status(200).json({ message: "Xóa mềm đánh giá thành công", review });
  } catch (error) {
    console.error("Lỗi khi xóa mềm đánh giá:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi xóa mềm đánh giá", error: error.message });
  }
});

module.exports = router;