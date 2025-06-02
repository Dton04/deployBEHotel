const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Booking = require("../models/booking");
const Room = require("../models/room");
const Discount = require("../models/discount");
const Transaction = require('../models/transaction');
const User = require("../models/user");
const axios = require("axios");
const { protect } = require('../middleware/auth');

// Giả lập hàm xử lý thanh toán qua tài khoản ngân hàng
const processBankPayment = async (bookingData, session) => {
  try {
    const room = await Room.findById(bookingData.roomid).session(session);
    if (!room) {
      throw new Error("Không tìm thấy phòng để tính toán thanh toán.");
    }
    if (room.availabilityStatus !== "available") {
      throw new Error("Phòng không còn khả dụng để thanh toán.");
    }

    const checkinDate = new Date(bookingData.checkin);
    const checkoutDate = new Date(bookingData.checkout);
    const days = Math.ceil((checkoutDate - checkinDate) / (1000 * 60 * 60 * 24));

    const amount = room.rentperday * days;

    const bankInfo = {
      bankName: "Vietinbank",
      accountNumber: "104872827498",
      accountHolder: "Nguyen Tan Dat",
      amount: amount,
      content: `Thanh toán đặt phòng ${bookingData._id}`,
    };

    return {
      success: true,
      message: "Vui lòng chuyển khoản theo thông tin dưới đây để hoàn tất thanh toán. Bạn có 5 phút để hoàn thành.",
      bankInfo,
    };
  } catch (error) {
    throw new Error("Lỗi khi xử lý thanh toán qua tài khoản ngân hàng: " + error.message);
  }
};

// POST /api/bookings/apply-promotions - Áp dụng khuyến mãi
router.post("/apply-promotions", async (req, res) => {
  const { bookingData, voucherCodes } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!bookingData || !bookingData.roomid || !bookingData.bookingId || !voucherCodes || !Array.isArray(voucherCodes)) {
      return res.status(400).json({ message: "Dữ liệu đặt phòng, ID đặt phòng hoặc mã khuyến mãi không hợp lệ" });
    }

    if (!mongoose.Types.ObjectId.isValid(bookingData.roomid) || !mongoose.Types.ObjectId.isValid(bookingData.bookingId)) {
      return res.status(400).json ({ message: "ID phòng hoặc ID đặt phòng không hợp lệ" });
    }

    const booking = await Booking.findById(bookingData.bookingId).lean();
    if (!booking) {
      return res.status(404).json({ message: "Không tìm thấy đặt phòng" });
    }

    if (booking.status !== "pending" && booking.status !== "confirmed") {
      return res.status(400).json({ message: "Không thể áp dụng khuyến mãi cho đặt phòng đã hủy" });
    }

    const user = await User.findOne({ email: booking.email.toLowerCase() }).lean();
    if (!user) {
      return res.status(404).json({ message: "Không tìm thấy người dùng liên quan đến đặt phòng" });
    }

    const checkinDate = new Date(bookingData.checkin);
    const checkoutDate = new Date(bookingData.checkout);
    if (isNaN(checkinDate.getTime()) || isNaN(checkoutDate.getTime()) || checkinDate >= checkoutDate) {
      return res.status(400).json({ message: "Ngày nhận phòng hoặc trả phòng không hợp lệ" });
    }

    const room = await Room.findById(bookingData.roomid).lean();
    if (!room) {
      return res.status(404).json({ message: "Không tìm thấy phòng" });
    }

    const days = Math.ceil((checkoutDate - checkinDate) / (1000 * 60 * 60 * 24));
    let totalAmount = room.rentperday * days;

    const discounts = await Discount.find({ code: { $in: voucherCodes }, type: "voucher", isDeleted: false });
    if (!discounts.length) {
      return res.status(404).json({ message: "Không tìm thấy mã khuyến mãi hợp lệ" });
    }

    let totalDiscount = 0;
    const appliedVouchers = [];
    const session = await mongoose.startSession();

    try {
      session.startTransaction();

      for (const discount of discounts) {
        const now = new Date();
        if (now < discount.startDate || now > discount.endDate) {
          continue;
        }

        if (discount.applicableHotels.length > 0 && !discount.applicableHotels.some((id) => id.equals(bookingData.roomid))) {
          continue;
        }

        if (totalAmount < discount.minBookingAmount) {
          continue;
        }

        const userUsage = discount.usedBy ? discount.usedBy.find((u) => u.userId.equals(user._id)) : null;
        if (userUsage && userUsage.count >= 1) {
          continue;
        }

        let discountAmount = 0;
        if (discount.discountType === "percentage") {
          discountAmount = (totalAmount * discount.discountValue) / 100;
          if (discount.maxDiscount && discountAmount > discount.maxDiscount) {
            discountAmount = discount.maxDiscount;
          }
        } else if (discount.discountType === "fixed") {
          discountAmount = discount.discountValue;
        }

        if (!discount.isStackable && appliedVouchers.length > 0) {
          continue;
        }

        totalDiscount += discountAmount;
        appliedVouchers.push({
          code: discount.code,
          discount: discountAmount,
        });

        if (!discount.usedBy) discount.usedBy = [];
        if (userUsage) {
          userUsage.count += 1;
        } else {
          discount.usedBy.push({ userId: user._id, count: 1 });
        }
        await discount.save({ session });
      }

      totalAmount = Math.max(0, totalAmount - totalDiscount);

      await Booking.updateOne(
        { _id: bookingData.bookingId },
        { voucherDiscount: totalDiscount, appliedVouchers },
        { session }
      );

      await session.commitTransaction();
      res.status(200).json({
        message: "Áp dụng khuyến mãi thành công",
        totalAmount,
        appliedVouchers,
      });
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error("Lỗi khi áp dụng khuyến mãi:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi áp dụng khuyến mãi", error: error.message });
  }
});

// POST /api/bookings/checkout - Tạo giao dịch mới và tích điểm
router.post('/checkout', protect, async (req, res) => {
  const { bookingId } = req.body;
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    // Kiểm tra kết nối database
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Kết nối cơ sở dữ liệu chưa sẵn sàng');
    }

    // Kiểm tra bookingId hợp lệ
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      throw new Error('ID đặt phòng không hợp lệ');
    }

    // Kiểm tra giao dịch đã tồn tại
    const existingTransaction = await Transaction.findOne({ bookingId }).session(session);
    if (existingTransaction) {
      throw new Error('Giao dịch cho đặt phòng này đã được tạo trước đó');
    }

    // Tìm booking
    const booking = await Booking.findById(bookingId)
      .populate('roomid')
      .session(session);
    if (!booking) {
      throw new Error('Không tìm thấy đặt phòng');
    }

    // Kiểm tra trạng thái booking
    if (booking.status !== 'confirmed' || booking.paymentStatus !== 'paid') {
      throw new Error('Đặt phòng chưa được xác nhận hoặc chưa thanh toán, không thể tích điểm');
    }

    // Tìm user
    const user = await User.findOne({ email: booking.email.toLowerCase() })
      .session(session);
    if (!user) {
      throw new Error('Không tìm thấy người dùng liên quan đến đặt phòng');
    }

    // Kiểm tra quyền truy cập
    if (req.user._id.toString() !== user._id.toString() && !['admin', 'staff'].includes(req.user.role)) {
      throw new Error('Không có quyền tích điểm cho người dùng này');
    }

    // Tính số tiền booking
    const checkinDate = new Date(booking.checkin);
    const checkoutDate = new Date(booking.checkout);
    const days = Math.ceil((checkoutDate - checkinDate) / (1000 * 60 * 60 * 24));
    const totalAmount = booking.roomid.rentperday * days - (booking.voucherDiscount || 0);

    // Tính điểm (1 điểm cho mỗi 100,000 VND)
    const pointsEarned = Math.floor(totalAmount * 0.01);

    // Tạo giao dịch
    const transaction = new Transaction({
      userId: user._id,
      bookingId: booking._id,
      amount: totalAmount,
      points: pointsEarned,
      type: 'earn',
      status: 'completed',
    });
    await transaction.save({ session });

    // Cập nhật điểm cho user
    user.points = (user.points || 0) + pointsEarned;
    await user.save({ session });

    // Commit transaction
    await session.commitTransaction();

    res.status(201).json({
      message: 'Tích điểm thành công',
      transaction,
      pointsEarned,
      totalPoints: user.points,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Lỗi khi tích điểm:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi tích điểm', error: error.message });
  } finally {
    session.endSession();
  }
});

// POST /api/bookings - Đặt phòng
router.post("/", async (req, res) => {
  const { roomid, name, email, phone, checkin, checkout, adults, children, roomType, paymentMethod } = req.body;
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    if (!mongoose.Types.ObjectId.isValid(roomid)) {
      throw new Error("ID phòng không hợp lệ");
    }

    if (!name || !email || !phone || !checkin || !checkout || !adults || !roomType || !paymentMethod) {
      throw new Error("Thiếu các trường bắt buộc");
    }

    if (!["cash", "credit_card", "bank_transfer", "mobile_payment", "vnpay"].includes(paymentMethod)) { // Thêm "vnpay" vào đây
      throw new Error("Phương thức thanh toán không hợp lệ");
    }

    const checkinDate = new Date(checkin);
    const checkoutDate = new Date(checkout);
    if (isNaN(checkinDate.getTime()) || isNaN(checkoutDate.getTime()) || checkinDate >= checkoutDate) {
      throw new Error("Ngày nhận phòng hoặc trả phòng không hợp lệ");
    }

    const room = await Room.findById(roomid).session(session);
    if (!room) {
      throw new Error("Không tìm thấy phòng");
    }

    if (room.availabilityStatus !== "available") {
      throw new Error(`Phòng đang ở trạng thái ${room.availabilityStatus}, không thể đặt`);
    }

    if (room.maxcount < Number(adults) + Number(children)) {
      throw new Error("Số lượng người vượt quá sức chứa của phòng");
    }

    const isRoomBooked = room.currentbookings.some((booking) => {
      const existingCheckin = new Date(booking.checkin);
      const existingCheckout = new Date(booking.checkout);
      return (
        (checkinDate >= existingCheckin && checkinDate < existingCheckout) ||
        (checkoutDate > existingCheckin && checkoutDate <= existingCheckout) ||
        (checkinDate <= existingCheckin && checkoutDate >= existingCheckout)
      );
    });

    if (isRoomBooked) {
      throw new Error("Phòng đã được đặt trong khoảng thời gian này");
    }

    const newBooking = new Booking({
      roomid,
      name,
      email: email.toLowerCase(),
      phone,
      checkin: checkinDate,
      checkout: checkoutDate,
      adults: Number(adults),
      children: Number(children) || 0,
      roomType,
      paymentMethod,
      paymentStatus: "pending",
      paymentDeadline: paymentMethod === "bank_transfer" ? new Date(Date.now() + 5 * 60 * 1000) : null,
    });

    await newBooking.save({ session });

    let paymentResult;
    if (paymentMethod === "bank_transfer") {
      paymentResult = await processBankPayment(newBooking, session);
    }

    room.currentbookings.push({
      bookingId: newBooking._id,
      checkin: checkinDate,
      checkout: checkoutDate,
    });
    await room.save({ session });

    await session.commitTransaction();
    res.status(201).json({ message: "Đặt phòng thành công", booking: newBooking, paymentResult });
  } catch (error) {
    await session.abortTransaction();
    console.error("Lỗi khi đặt phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi đặt phòng", error: error.message });
  } finally {
    session.endSession();
  }
});

// POST /api/bookings/bookroom - Đặt phòng
router.post("/bookroom", async (req, res) => {
  const {
    roomid,
    name,
    email,
    phone,
    checkin,
    checkout,
    adults,
    children,
    roomType,
    specialRequest,
    paymentMethod,
    orderId,
    momoRequestId,
    diningServices, // Thêm diningServices
  } = req.body;
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    if (!mongoose.Types.ObjectId.isValid(roomid)) {
      throw new Error("ID phòng không hợp lệ");
    }

    if (!name || !email || !phone || !checkin || !checkout || !adults || children == null || !roomType || !paymentMethod) {
      throw new Error("Thiếu các trường bắt buộc");
    }

    if (!["cash", "credit_card", "bank_transfer", "mobile_payment", "vnpay"].includes(paymentMethod)) {
      throw new Error("Phương thức thanh toán không hợp lệ");
    }

    // Kiểm tra diningServices
    if (diningServices && !Array.isArray(diningServices)) {
      throw new Error("Danh sách dịch vụ không hợp lệ");
    }

    const checkinDate = new Date(checkin);
    const checkoutDate = new Date(checkout);
    if (isNaN(checkinDate.getTime()) || isNaN(checkoutDate.getTime()) || checkinDate >= checkoutDate) {
      throw new Error("Ngày nhận phòng hoặc trả phòng không hợp lệ");
    }

    const room = await Room.findById(roomid).session(session);
    if (!room) {
      throw new Error("Không tìm thấy phòng");
    }

    if (room.availabilityStatus !== "available") {
      throw new Error(`Phòng đang ở trạng thái ${room.availabilityStatus}, không thể đặt`);
    }

    if (room.maxcount < Number(adults) + Number(children)) {
      throw new Error("Số lượng người vượt quá sức chứa của phòng");
    }

    const isRoomBooked = room.currentbookings.some((booking) => {
      const existingCheckin = new Date(booking.checkin);
      const existingCheckout = new Date(booking.checkout);
      return (
        (checkinDate >= existingCheckin && checkinDate < existingCheckout) ||
        (checkoutDate > existingCheckin && checkoutDate <= existingCheckout) ||
        (checkinDate <= existingCheckin && checkoutDate >= existingCheckout)
      );
    });

    if (isRoomBooked) {
      throw new Error("Phòng đã được đặt trong khoảng thời gian này");
    }

    const newBooking = new Booking({
      roomid,
      name,
      email: email.toLowerCase(),
      phone,
      checkin: checkinDate,
      checkout: checkoutDate,
      adults: Number(adults),
      children: Number(children),
      roomType,
      specialRequest,
      paymentMethod,
      paymentStatus: "pending",
      paymentDeadline: paymentMethod === "bank_transfer" ? new Date(Date.now() + 5 * 60 * 1000) : null,
      momoOrderId: paymentMethod === "mobile_payment" ? orderId : null,
      momoRequestId: paymentMethod === "mobile_payment" ? momoRequestId : null,
      vnpOrderId: paymentMethod === "vnpay" ? orderId : null,
      vnpRequestId: paymentMethod === "vnpay" ? orderId : null,
      diningServices: diningServices || [], // Lưu danh sách dịch vụ
    });

    await newBooking.save({ session });

    let paymentResult;
    if (paymentMethod === "bank_transfer") {
      paymentResult = await processBankPayment(newBooking, session);
    }

    room.currentbookings.push({
      bookingId: newBooking._id,
      checkin: checkinDate,
      checkout: checkoutDate,
    });
    await room.save({ session });

    await session.commitTransaction();
    res.status(201).json({ message: "Đặt phòng thành công", booking: newBooking, paymentResult });
  } catch (error) {
    await session.abortTransaction();
    console.error("Lỗi trong API đặt phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi đặt phòng", error: error.message });
  } finally {
    session.endSession();
  }
});

// POST /api/bookings/momo/verify-payment - Kiểm tra trạng thái thanh toán MoMo
router.post("/momo/verify-payment", async (req, res) => {
  const { bookingId, momoOrderId } = req.body;

  try {
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: "ID đặt phòng không hợp lệ" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Không tìm thấy đặt phòng" });
    }

    if (booking.momoOrderId !== momoOrderId) {
      return res.status(400).json({ message: "Order ID không khớp" });
    }

    const momoVerifyResponse = await axios.post("https://api.momo.vn/verify-payment", {
      orderId: momoOrderId,
      requestId: booking.momoRequestId,
    });

    if (momoVerifyResponse.data.status === "success") {
      booking.paymentStatus = "paid";
      booking.status = "confirmed";
      booking.momoTransactionId = momoVerifyResponse.data.transactionId;
      await booking.save();

      // Tự động tích điểm sau khi thanh toán MoMo thành công
      try {
        const user = await User.findOne({ email: booking.email.toLowerCase() });
        if (user) {
          const session = await mongoose.startSession();
          try {
            session.startTransaction();
            const checkinDate = new Date(booking.checkin);
            const checkoutDate = new Date(booking.checkout);
            const days = Math.ceil((checkoutDate - checkinDate) / (1000 * 60 * 60 * 24));
            const room = await Room.findById(booking.roomid).session(session);
            const totalAmount = room.rentperday * days - (booking.voucherDiscount || 0);
            const pointsEarned = Math.floor(totalAmount * 0.01);

            const transaction = new Transaction({
              userId: user._id,
              bookingId: booking._id,
              amount: totalAmount,
              points: pointsEarned,
              type: 'earn',
              status: 'completed',
            });
            await transaction.save({ session });

            user.points = (user.points || 0) + pointsEarned;
            await user.save({ session });

            await session.commitTransaction();
          } catch (error) {
            await session.abortTransaction();
            throw error;
          } finally {
            session.endSession();
          }
        }
      } catch (error) {
        console.error('Lỗi khi tích điểm tự động:', error.message);
      }

      res.status(200).json({ message: "Thanh toán MoMo thành công", booking });
    } else {
      res.status(400).json({ message: "Thanh toán MoMo thất bại hoặc đang chờ xử lý" });
    }
  } catch (error) {
    console.error("Lỗi khi kiểm tra thanh toán MoMo:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi kiểm tra thanh toán MoMo", error: error.message });
  }
});

// GET /api/bookings/history/:userId - Lịch sử đặt phòng
router.get("/history/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "ID người dùng không hợp lệ" });
    }

    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({ message: "Không tìm thấy người dùng" });
    }

    const bookings = await Booking.find({ email: user.email.toLowerCase() })
      .populate("roomid")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json(bookings);
  } catch (error) {
    console.error("Lỗi khi lấy lịch sử đặt phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy lịch sử đặt phòng", error: error.message });
  }
});

// GET /api/bookings/:id/payment-deadline - Kiểm tra thời hạn thanh toán
router.get("/:id/payment-deadline", async (req, res) => {
  const { id } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID đặt phòng không hợp lệ" });
    }

    const booking = await Booking.findById(id).populate("roomid").lean();
    if (!booking) {
      return res.status(404).json({ message: "Không tìm thấy đặt phòng với ID này" });
    }

    if (booking.paymentMethod !== "bank_transfer") {
      return res.status(400).json({ message: "Đặt phòng này không sử dụng thanh toán qua ngân hàng" });
    }

    if (!booking.paymentDeadline) {
      return res.status(400).json({ message: "Không có thời hạn thanh toán cho đặt phòng này" });
    }

    const currentTime = new Date();
    const timeRemaining = booking.paymentDeadline - currentTime;

    if (timeRemaining <= 0 && booking.paymentStatus === "pending") {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        booking.status = "canceled";
        booking.paymentStatus = "canceled";
        await Booking.updateOne({ _id: id }, booking, { session });

        const room = await Room.findById(booking.roomid).session(session);
        if (room) {
          room.currentbookings = room.currentbookings.filter((b) => b.bookingId && b.bookingId.toString() !== id);
          await room.save({ session });
        }

        await session.commitTransaction();
        return res.status(200).json({
          message: "Thời gian thanh toán đã hết. Đặt phòng đã bị hủy.",
          timeRemaining: 0,
          expired: true,
        });
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        session.endSession();
      }
    }

    res.status(200).json({
      message: "Thời gian thanh toán còn lại",
      timeRemaining: Math.max(0, Math.floor(timeRemaining / 1000)),
      expired: false,
    });
  } catch (error) {
    console.error("Lỗi khi kiểm tra thời gian thanh toán:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi kiểm tra thời gian thanh toán", error: error.message });
  }
});

// GET /api/bookings/summary - Lấy số lượng booking theo trạng thái
router.get("/summary", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }
    const summary = await Booking.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).exec();
    const result = { pending: 0, confirmed: 0, canceled: 0 };
    summary.forEach((item) => {
      result[item._id] = item.count;
    });
    res.status(200).json(result);
  } catch (error) {
    console.error("Lỗi khi lấy thống kê trạng thái đặt phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy thống kê trạng thái đặt phòng", error: error.message });
  }
});

// GET /api/bookings/recent - Lấy danh sách đặt phòng mới nhất
router.get("/recent", async (req, res) => {
  const { limit = 10 } = req.query;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    const parsedLimit = parseInt(limit);
    if (isNaN(parsedLimit) || parsedLimit < 1) {
      return res.status(400).json({ message: "Giới hạn phải là số nguyên dương" });
    }

    const bookings = await Booking.find()
      .sort({ createdAt: -1 })
      .limit(parsedLimit)
      .populate("roomid")
      .lean();

    res.status(200).json(bookings);
  } catch (error) {
    console.error("Lỗi khi lấy danh sách đặt phòng mới nhất:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy danh sách đặt phòng mới nhất", error: error.message });
  }
});

// POST /api/bookings/validate - Kiểm tra dữ liệu đặt phòng
router.post("/validate", async (req, res) => {
  const { roomid, checkin, checkout, adults, children, roomType } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(roomid)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }

    if (!checkin || !checkout || !adults || children == null || !roomType) {
      return res.status(400).json({ message: "Thiếu các trường bắt buộc" });
    }

    const checkinDate = new Date(checkin);
    const checkoutDate = new Date(checkout);
    if (isNaN(checkinDate.getTime()) || isNaN(checkoutDate.getTime())) {
      return res.status(400).json({ message: "Ngày nhận phòng hoặc trả phòng không hợp lệ" });
    }

    if (checkinDate >= checkoutDate) {
      return res.status(400).json({ message: "Ngày nhận phòng phải trước ngày trả phòng" });
    }

    const room = await Room.findById(roomid).lean();
    if (!room) {
      return res.status(404).json({ message: "Không tìm thấy phòng" });
    }

    if (room.availabilityStatus !== "available") {
      return res.status(400).json({ message: `Phòng đang ở trạng thái ${room.availabilityStatus}, không thể đặt` });
    }

    if (room.type !== roomType) {
      return res.status(400).json({ message: "Loại phòng không khớp với phòng được chọn" });
    }

    if (room.maxcount < Number(adults) + Number(children)) {
      return res.status(400).json({ message: "Số lượng người vượt quá sức chứa của phòng" });
    }

    const isRoomBooked = room.currentbookings.some((booking) => {
      const existingCheckin = new Date(booking.checkin);
      const existingCheckout = new Date(booking.checkout);
      return (
        (checkinDate >= existingCheckin && checkinDate < existingCheckout) ||
        (checkoutDate > existingCheckin && checkoutDate <= existingCheckout) ||
        (checkinDate <= existingCheckin && checkoutDate >= existingCheckout)
      );
    });

    if (isRoomBooked) {
      return res.status(400).json({ message: "Phòng đã được đặt trong khoảng thời gian này" });
    }

    res.status(200).json({ message: "Dữ liệu đặt phòng hợp lệ" });
  } catch (error) {
    console.error("Lỗi khi kiểm tra dữ liệu đặt phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi kiểm tra dữ liệu đặt phòng", error: error.message });
  }
});

// GET /api/bookings/cancel-reason - Lấy lý do hủy
router.get("/cancel-reason", async (req, res) => {
  const { bookingId } = req.query;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: "ID đặt phòng không hợp lệ hoặc thiếu" });
    }

    const booking = await Booking.findById(bookingId).lean();
    if (!booking) {
      return res.status(404).json({ message: "Không tìm thấy đặt phòng với ID này" });
    }

    if (booking.status !== "canceled") {
      return res.status(400).json({ message: "Đặt phòng này chưa bị hủy" });
    }

    if (!booking.cancelReason) {
      return res.status(404).json({ message: "Không tìm thấy lý do hủy cho đặt phòng này" });
    }

    res.status(200).json({ cancelReason: booking.cancelReason });
  } catch (error) {
    console.error("Lỗi khi lấy lý do hủy:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy lý do hủy", error: error.message });
  }
});

// GET /api/bookings/check - Kiểm tra đặt phòng
router.get("/check", async (req, res) => {
  const { email, roomId } = req.query;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!email) {
      return res.status(400).json({ message: "Email là bắt buộc" });
    }

    let query = { email: email.toLowerCase(), paymentStatus: "paid", status: "confirmed" };
    
    if (roomId) {
      try {
       let roomIds = roomId;
if (typeof roomId === 'string' && roomId.includes('$in')) {
  try {
    roomIds = JSON.parse(roomId).$in;
  } catch (error) {
    console.error("Lỗi khi parse roomId:", error.message);
    return res.status(400).json({ message: "Định dạng roomId không hợp lệ" });
  }
} else if (typeof roomId === 'string') {
  roomIds = [roomId];
}

        const validRoomIds = roomIds.filter(id => mongoose.Types.ObjectId.isValid(id));
        if (validRoomIds.length === 0) {
          return res.status(400).json({ message: "Không có roomId hợp lệ" });
        }

        query.roomid = { $in: validRoomIds };
        console.log("Checking bookings with email:", email, "and roomIds:", validRoomIds); // Thêm log
      } catch (error) {
        console.error("Lỗi khi parse roomId:", error.message);
        return res.status(400).json({ message: "Định dạng roomId không hợp lệ" });
      }
    }

    const booking = await Booking.findOne(query).lean();
    if (!booking) {
      console.log("No booking found for query:", query); // Thêm log
      return res.status(404).json({ 
        hasBooked: false, 
        message: "Không tìm thấy đặt phòng với email và roomId này" 
      });
    }

    console.log("Found booking:", booking); // Thêm log
    res.status(200).json({ 
      hasBooked: true, 
      booking, 
      paymentStatus: booking.paymentStatus 
    });
  } catch (error) {
    console.error("Lỗi khi kiểm tra đặt phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi kiểm tra đặt phòng", error: error.message });
  }
});

// GET /api/bookings/:id - Lấy chi tiết đặt phòng
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID đặt phòng không hợp lệ" });
    }

    const booking = await Booking.findById(id).populate("roomid").lean();
    if (!booking) {
      return res.status(404).json({ message: "Không tìm thấy đặt phòng với ID này" });
    }

    res.status(200).json(booking);
  } catch (error) {
    console.error("Lỗi khi lấy chi tiết đặt phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy chi tiết đặt phòng", error: error.message });
  }
});

// PUT /api/bookings/:id/cancel - Hủy đặt phòng
router.put("/:id/cancel", async (req, res) => {
  const { id } = req.params;
  const { cancelReason } = req.body;
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error("ID đặt phòng không hợp lệ");
    }

    if (!cancelReason || cancelReason.trim() === "") {
      throw new Error("Lý do hủy không được để trống");
    }

    const booking = await Booking.findById(id).session(session);
    if (!booking) {
      throw new Error("Không tìm thấy đặt phòng với ID này");
    }

    if (booking.status === "canceled") {
      throw new Error("Đặt phòng này đã bị hủy trước đó");
    }

    if (booking.status === "confirmed") {
      throw new Error("Không thể hủy đặt phòng đã được xác nhận");
    }

    booking.status = "canceled";
    booking.paymentStatus = "canceled";
    booking.cancelReason = cancelReason;
    await booking.save({ session });

    const room = await Room.findById(booking.roomid).session(session);
    if (room) {
      room.currentbookings = room.currentbookings.filter((b) => b.bookingId && b.bookingId.toString() !== id);
      await room.save({ session });
    }

    await session.commitTransaction();
    res.status(200).json({ message: "Hủy đặt phòng thành công", booking });
  } catch (error) {
    await session.abortTransaction();
    console.error("Lỗi khi hủy đặt phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi hủy đặt phòng", error: error.message });
  } finally {
    session.endSession();
  }
});

// PUT /api/bookings/:id/confirm - Xác nhận đặt phòng
router.put("/:id/confirm", async (req, res) => {
  const { id } = req.params;
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error("ID đặt phòng không hợp lệ");
    }

    const booking = await Booking.findById(id).session(session);
    if (!booking) {
      throw new Error("Không tìm thấy đặt phòng với ID này");
    }

    if (booking.status === "confirmed") {
      throw new Error("Đặt phòng này đã được xác nhận trước đó");
    }

    if (booking.status === "canceled") {
      throw new Error("Không thể xác nhận một đặt phòng đã bị hủy");
    }

    booking.status = "confirmed";
    booking.paymentStatus = "paid";
    await booking.save({ session });

    // Tự động tích điểm sau khi xác nhận thanh toán
    try {
      const user = await User.findOne({ email: booking.email.toLowerCase() }).session(session);
      if (user) {
        const room = await Room.findById(booking.roomid).session(session);
        const checkinDate = new Date(booking.checkin);
        const checkoutDate = new Date(booking.checkout);
        const days = Math.ceil((checkoutDate - checkinDate) / (1000 * 60 * 60 * 24));
        const totalAmount = room.rentperday * days - (booking.voucherDiscount || 0);
        const pointsEarned = Math.floor(totalAmount * 0.01);

        const existingTransaction = await Transaction.findOne({ bookingId: id }).session(session);
        if (!existingTransaction) {
          const transaction = new Transaction({
            userId: user._id,
            bookingId: booking._id,
            amount: totalAmount,
            points: pointsEarned,
            type: 'earn',
            status: 'completed',
          });
          await transaction.save({ session });

          user.points = (user.points || 0) + pointsEarned;
          await user.save({ session });
        }
      }
    } catch (error) {
      console.error('Lỗi khi tích điểm tự động:', error.message);
    }

    await session.commitTransaction();
    res.status(200).json({ message: "Xác nhận đặt phòng thành công", booking });
  } catch (error) {
    await session.abortTransaction();
    console.error("Lỗi khi xác nhận đặt phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi xác nhận đặt phòng", error: error.message });
  } finally {
    session.endSession();
  }
});

// GET /api/bookings - Lấy danh sách đặt phòng
router.get("/", async (req, res) => {
  const { status, email } = req.query;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    const query = {};
    if (status && ["pending", "confirmed", "canceled"].includes(status)) {
      query.status = status;
    }
    if (email) {
      query.email = email.toLowerCase();
    }

    const bookings = await Booking.find(query).populate("roomid").lean();
    res.status(200).json(bookings);
  } catch (error) {
    console.error("Lỗi khi lấy danh sách đặt phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy danh sách đặt phòng", error: error.message });
  }
});

// GET /api/bookings/room/:roomId - Lấy danh sách đặt phòng theo phòng
router.get("/room/:roomId", async (req, res) => {
  const { roomId } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(roomId)) {
      return res.status(400).json({ message: "ID phòng không hợp lệ" });
    }

    const bookings = await Booking.find({ roomid: roomId }).populate("roomid").lean();
    if (!bookings.length) {
      return res.status(404).json({ message: "Không tìm thấy đặt phòng nào cho phòng này" });
    }

    res.status(200).json(bookings);
  } catch (error) {
    console.error("Lỗi khi lấy danh sách đặt phòng theo phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy danh sách đặt phòng theo phòng", error: error.message });
  }
});

// GET /api/bookings/stats/daily - Thống kê doanh thu theo ngày
router.get("/stats/daily", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    const bookings = await Booking.find({ status: "confirmed" }).populate("roomid").lean();

    const dailyRevenue = bookings.reduce((acc, booking) => {
      if (!booking.roomid || !booking.roomid.rentperday) return acc;

      const checkinDate = new Date(booking.checkin);
      const checkoutDate = new Date(booking.checkout);
      const days = Math.ceil((checkoutDate - checkinDate) / (1000 * 60 * 60 * 24));

      const dateKey = checkinDate.toISOString().split("T")[0];

      acc[dateKey] = (acc[dateKey] || 0) + booking.roomid.rentperday * days;
      return acc;
    }, {});

    res.status(200).json(dailyRevenue);
  } catch (error) {
    console.error("Lỗi khi lấy thống kê doanh thu theo ngày:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy thống kê doanh thu theo ngày", error: error.message });
  }
});

// GET /api/bookings/stats/monthly - Thống kê doanh thu theo tháng
router.get("/stats/monthly", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    const bookings = await Booking.find({ status: "confirmed" }).populate("roomid").lean();

    const monthlyRevenue = bookings.reduce((acc, booking) => {
      if (!booking.roomid || !booking.roomid.rentperday) return acc;

      const checkinDate = new Date(booking.checkin);
      const checkoutDate = new Date(booking.checkout);
      const days = Math.ceil((checkoutDate - checkinDate) / (1000 * 60 * 60 * 24));

      const monthKey = `${checkinDate.getFullYear()}-${String(checkinDate.getMonth() + 1).padStart(2, "0")}`;

      acc[monthKey] = (acc[monthKey] || 0) + booking.roomid.rentperday * days;
      return acc;
    }, {});

    res.status(200).json(monthlyRevenue);
  } catch (error) {
    console.error("Lỗi khi lấy thống kê doanh thu theo tháng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi lấy thống kê doanh thu theo tháng", error: error.message });
  }
});

// PATCH /api/bookings/:id/note - Cập nhật ghi chú
router.patch("/:id/note", async (req, res) => {
  const { id } = req.params;
  const { note } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID đặt phòng không hợp lệ" });
    }

    if (!note || note.trim() === "") {
      return res.status(400).json({ message: "Ghi chú không được để trống" });
    }

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ message: "Không tìm thấy đặt phòng với ID này" });
    }

    if (booking.status === "canceled") {
      return res.status(400).json({ message: "Không thể thêm ghi chú cho đặt phòng đã hủy" });
    }

    booking.specialRequest = note;
    await booking.save();

    res.status(200).json({ message: "Cập nhật ghi chú thành công", booking });
  } catch (error) {
    console.error("Lỗi khi cập nhật ghi chú:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi cập nhật ghi chú", error: error.message });
  }
});

// POST /api/bookings/:id/assign-room - Gán phòng mới
router.post("/:id/assign-room", async (req, res) => {
  const { id } = req.params;
  const { newRoomId } = req.body;
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error("ID đặt phòng không hợp lệ");
    }

    if (!mongoose.Types.ObjectId.isValid(newRoomId)) {
      throw new Error("ID phòng mới không hợp lệ");
    }

    const booking = await Booking.findById(id).session(session);
    if (!booking) {
      throw new Error("Không tìm thấy đặt phòng với ID này");
    }

    if (booking.status === "canceled") {
      throw new Error("Không thể gán phòng cho đặt phòng đã hủy");
    }

    const oldRoom = await Room.findById(booking.roomid).session(session);
    const newRoom = await Room.findById(newRoomId).session(session);

    if (!newRoom) {
      throw new Error("Không tìm thấy phòng mới");
    }

    if (newRoom.availabilityStatus !== "available") {
      throw new Error(`Phòng mới đang ở trạng thái ${newRoom.availabilityStatus}, không thể gán`);
    }

    if (newRoom.type !== booking.roomType) {
      throw new Error("Loại phòng mới không khớp với loại phòng đã đặt");
    }

    const isNewRoomBooked = newRoom.currentbookings.some((b) => {
      const existingCheckin = new Date(b.checkin);
      const existingCheckout = new Date(b.checkout);
      return (
        (booking.checkin >= existingCheckin && booking.checkin < existingCheckout) ||
        (booking.checkout > existingCheckin && booking.checkout <= existingCheckout) ||
        (booking.checkin <= existingCheckin && booking.checkout >= existingCheckout)
      );
    });

    if (isNewRoomBooked) {
      throw new Error("Phòng mới đã được đặt trong khoảng thời gian này");
    }

    if (oldRoom) {
      oldRoom.currentbookings = oldRoom.currentbookings.filter((b) => b.bookingId && b.bookingId.toString() !== id);
      await oldRoom.save({ session });
    }

    booking.roomid = newRoomId;
    await booking.save({ session });

    newRoom.currentbookings.push({
      bookingId: booking._id,
      checkin: booking.checkin,
      checkout: booking.checkout,
    });
    await newRoom.save({ session });

    await session.commitTransaction();
    res.status(200).json({ message: "Gán phòng mới thành công", booking });
  } catch (error) {
    await session.abortTransaction();
    console.error("Lỗi khi gán phòng:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi gán phòng", error: error.message });
  } finally {
    session.endSession();
  }
});

// PATCH /api/bookings/:id/extend - Gia hạn thời gian lưu trú
router.patch("/:id/extend", async (req, res) => {
  const { id } = req.params;
  const { newCheckout } = req.body;
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error("ID đặt phòng không hợp lệ");
    }

    if (!newCheckout) {
      throw new Error("Ngày trả phòng mới là bắt buộc");
    }

    const newCheckoutDate = new Date(newCheckout);
    if (isNaN(newCheckoutDate.getTime())) {
      throw new Error("Ngày trả phòng mới không hợp lệ");
    }

    const booking = await Booking.findById(id).session(session);
    if (!booking) {
      throw new Error("Không tìm thấy đặt phòng với ID này");
    }

    if (booking.status === "canceled") {
      throw new Error("Không thể gia hạn cho đặt phòng đã hủy");
    }

    const oldCheckoutDate = new Date(booking.checkout);
    if (newCheckoutDate <= oldCheckoutDate) {
      throw new Error("Ngày trả phòng mới phải sau ngày trả phòng hiện tại");
    }

    const room = await Room.findById(booking.roomid).session(session);
    if (!room) {
      throw new Error("Không tìm thấy phòng liên quan đến đặt phòng này");
    }

    const isRoomBooked = room.currentbookings.some((b) => {
      if (b.bookingId && b.bookingId.toString() === id) return false;
      const existingCheckin = new Date(b.checkin);
      const existingCheckout = new Date(b.checkout);
      return (
        (oldCheckoutDate < existingCheckin && newCheckoutDate > existingCheckin) ||
        (oldCheckoutDate < existingCheckout && newCheckoutDate > existingCheckout)
      );
    });

    if (isRoomBooked) {
      throw new Error("Phòng không khả dụng trong khoảng thời gian gia hạn");
    }

    booking.checkout = newCheckoutDate;
    await booking.save({ session });

    const bookingInRoom = room.currentbookings.find((b) => b.bookingId && b.bookingId.toString() === id);
    if (bookingInRoom) {
      bookingInRoom.checkout = newCheckoutDate;
      await room.save({ session });
    }

    await session.commitTransaction();
    res.status(200).json({ message: "Gia hạn thời gian lưu trú thành công", booking });
  } catch (error) {
    await session.abortTransaction();
    console.error("Lỗi khi gia hạn thời gian lưu trú:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi gia hạn thời gian lưu trú", error: error.message });
  } finally {
    session.endSession();
  }
});

// POST /api/bookings/cancel-reason - Gửi lý do hủy
router.post("/cancel-reason", async (req, res) => {
  const { bookingId, reason } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: "ID đặt phòng không hợp lệ hoặc thiếu" });
    }

    if (!reason || reason.trim() === "") {
      return res.status(400).json({ message: "Lý do hủy không được để trống" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Không tìm thấy đặt phòng với ID này" });
    }

    if (booking.status !== "canceled") {
      return res.status(400).json({ message: "Đặt phòng này chưa bị hủy" });
    }

    booking.cancelReason = reason;
    await booking.save();

    res.status(200).json({ message: "Gửi lý do hủy thành công", booking });
  } catch (error) {
    console.error("Lỗi khi gửi lý do hủy:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi gửi lý do hủy", error: error.message });
  }
});

// PATCH /api/bookings/:id/payment-method - Cập nhật phương thức thanh toán
router.patch("/:id/payment-method", async (req, res) => {
  const { id } = req.params;
  const { paymentMethod } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: "Kết nối cơ sở dữ liệu chưa sẵn sàng" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID đặt phòng không hợp lệ" });
    }

    if (!["cash", "credit_card", "bank_transfer", "mobile_payment", "vnpay"].includes(paymentMethod)) { // Thêm "vnpay" vào đây
      return res.status(400).json({ message: "Phương thức thanh toán không hợp lệ" });
    }

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ message: "Không tìm thấy đặt phòng với ID này" });
    }

    if (booking.status === "canceled") {
      return res.status(400).json({ message: "Không thể cập nhật phương thức thanh toán cho đặt phòng đã hủy" });
    }

    booking.paymentMethod = paymentMethod;
    await booking.save();

    res.status(200).json({ message: "Cập nhật phương thức thanh toán thành công", booking });
  } catch (error) {
    console.error("Lỗi khi cập nhật phương thức thanh toán:", error.message, error.stack);
    res.status(500).json({ message: "Lỗi khi cập nhật phương thức thanh toán", error: error.message });
  }
});

module.exports = router;