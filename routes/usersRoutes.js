const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/user');
const Booking = require('../models/booking');
const Review = require('../models/review');
const Transaction = require('../models/transaction');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const { protect, admin, staff } = require('../middleware/auth');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const otpGenerator = require('otp-generator');
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

// Middleware kiểm tra admin hoặc staff
const adminOrStaff = (req, res, next) => {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'staff')) {
    next();
  } else {
    res.status(403).json({ message: 'Not authorized as admin or staff' });
  }
};

// Cấu hình Passport cho Google OAuth
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_REDIRECT_URI
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    if (!user) {
      user = await User.findOne({ email: profile.emails[0].value });
      if (user) {
        user.googleId = profile.id;
        await user.save();
      } else {
        user = new User({
          name: profile.displayName,
          email: profile.emails[0].value.toLowerCase(),
          googleId: profile.id,
          role: 'user',
          isAdmin: false,
          isDeleted: false
        });
        await user.save();
      }
    }
    if (user.isDeleted) {
      return done(null, false, { message: 'Tài khoản của bạn đã bị xóa' });
    }
    return done(null, user);
  } catch (error) {
    return done(error, null);
  }
}));

// Cấu hình Passport cho Facebook OAuth
passport.use(new FacebookStrategy({
  clientID: process.env.FACEBOOK_APP_ID,
  clientSecret: process.env.FACEBOOK_APP_SECRET,
  callbackURL: process.env.FACEBOOK_REDIRECT_URI,
  profileFields: ['id', 'displayName', 'emails']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ facebookId: profile.id });
    if (!user) {
      user = await User.findOne({ email: profile.emails?.[0]?.value });
      if (user) {
        user.facebookId = profile.id;
        await user.save();
      } else {
        user = new User({
          name: profile.displayName,
          email: profile.emails?.[0]?.value?.toLowerCase() || `${profile.id}@facebook.com`,
          facebookId: profile.id,
          role: 'user',
          isAdmin: false,
          isDeleted: false
        });
        await user.save();
      }
    }
    if (user.isDeleted) {
      return done(null, false, { message: 'Tài khoản của bạn đã bị xóa' });
    }
    return done(null, user);
  } catch (error) {
    return done(error, null);
  }
}));

// Serialize và deserialize user
passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

/**
 * @route   POST /api/users/register
 * @desc    Đăng ký người dùng mới
 * @access  Công khai (không yêu cầu xác thực)
 */
router.post('/register', async (req, res) => {
  const { name, email, password, isAdmin, role, phone } = req.body;

  try {
    const normalizedEmail = email.toLowerCase();
    const userExists = await User.findOne({ email: normalizedEmail });
    if (userExists) {
      return res.status(400).json({ message: 'Email đã được đăng ký' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      name,
      email: normalizedEmail,
      password, // Lưu mật khẩu dạng plain text
      isAdmin: isAdmin || false,
      role: role || 'user',
      phone,
    });

    const savedUser = await user.save();

    res.status(201).json({
      _id: savedUser._id,
      name: savedUser.name,
      email: savedUser.email,
      isAdmin: savedUser.isAdmin,
      role: savedUser.role,
      phone: savedUser.phone,
    });
  } catch (error) {
    console.error('Register error:', error.message);
    res.status(400).json({ message: error.message });
  }
});

/**
 * @route   POST /api/users/login
 * @desc    Đăng nhập và nhận JWT token
 * @access  Công khai (không yêu cầu xác thực)
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    // Kiểm tra dữ liệu đầu vào
    if (!email || !password) {
      return res.status(400).json({ message: 'Vui lòng cung cấp email và mật khẩu' });
    }

    const normalizedEmail = email.toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(400).json({ message: 'Email không tồn tại' });
    }

    if (user.isDeleted) {
      return res.status(400).json({ message: 'Tài khoản đã bị xóa, vui lòng liên hệ CSKH' });
    }

    // Kiểm tra mật khẩu
    let isMatch;
    if (!user.password.startsWith('$2b$')) {
      // Hỗ trợ mật khẩu văn bản thô (cho các tài khoản cũ)
      isMatch = user.password === password;
      if (isMatch) {
        // Băm lại mật khẩu và cập nhật
        user.password = await bcrypt.hash(password, 10);
        await user.save();
      }
    } else {
      // So sánh mật khẩu đã băm
      isMatch = await bcrypt.compare(password, user.password);
    }

    if (!isMatch) {
      return res.status(400).json({ message: 'Mật khẩu không đúng' });
    }

    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET không được định nghĩa');
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: '1d',
    });

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      isAdmin: user.isAdmin,
      role: user.role,
      phone: user.phone,
      token,
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

/**
 * @route   GET /api/users/google
 * @desc    Chuyển hướng đến Google OAuth
 * @access  Công khai
 */
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

/**
 * @route   GET /api/users/google/callback
 * @desc    Xử lý callback từ Google OAuth
 * @access  Công khai
 */
router.get('/google/callback', passport.authenticate('google', { session: false, failureRedirect: 'http://localhost:3000/login?error=Google authentication failed' }), async (req, res) => {
    try {
      const user = await User.findById(req.user.id).select('-password');
      if (!user) {
        return res.redirect('http://localhost:3000/login?error=User not found');
      }

      // Tạo JWT token
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
        expiresIn: '1d',
      });

      // Chuẩn bị dữ liệu người dùng
      const userData = {
        _id: user._id,
        name: user.name,
        email: user.email,
        isAdmin: user.isAdmin,
        role: user.role,
        phone: user.phone,
        token,
        bookingsCount: await Booking.countDocuments({ email: user.email.toLowerCase() }),
      };

      // Mã hóa dữ liệu người dùng vào URL query
      const userDataParam = encodeURIComponent(JSON.stringify(userData));
      res.redirect(`http://localhost:3000/auth/google/callback?user=${userDataParam}`);
    } catch (error) {
      console.error('Google callback error:', error.message);
      res.redirect('http://localhost:3000/login?error=Google authentication failed');
    }
  }
);

/**
 * @route   GET /api/users/facebook
 * @desc    Chuyển hướng đến Facebook OAuth
 * @access  Công khai
 */
router.get('/facebook', passport.authenticate('facebook', { scope: ['email'] }));

/**
 * @route   GET /api/users/facebook/callback
 * @desc    Xử lý callback từ Facebook OAuth
 * @access  Công khai
 */
router.get(
  '/facebook/callback',
  passport.authenticate('facebook', { session: false, failureRedirect: 'http://localhost:3000/login?error=Facebook authentication failed' }),
  async (req, res) => {
    try {
      const user = await User.findById(req.user.id).select('-password');
      if (!user) {
        return res.redirect('http://localhost:3000/login?error=User not found');
      }

      // Tạo JWT token
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
        expiresIn: '1d',
      });

      // Chuẩn bị dữ liệu người dùng
      const userData = {
        _id: user._id,
        name: user.name,
        email: user.email,
        isAdmin: user.isAdmin,
        role: user.role,
        phone: user.phone,
        token,
        bookingsCount: await Booking.countDocuments({ email: user.email.toLowerCase() }),
      };

      // Mã hóa dữ liệu người dùng vào URL query
      const userDataParam = encodeURIComponent(JSON.stringify(userData));
      res.redirect(`http://localhost:3000/auth/facebook/callback?user=${userDataParam}`);
    } catch (error) {
      console.error('Facebook callback error:', error.message);
      res.redirect('http://localhost:3000/login?error=Facebook authentication failed');
    }
  }
);

/**
 * @route   GET /api/users/points
 * @desc    Lấy điểm tích lũy của người dùng hiện tại
 * @access  Riêng tư (yêu cầu token, tất cả vai trò: user, staff, admin)
 */
router.get('/points', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('points');
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng' });
    }

    // Lấy lịch sử giao dịch liên quan đến điểm
    const transactions = await Transaction.find({ userId: req.user.id })
      .select('points amount bookingId createdAt')
      .populate('bookingId', 'checkin checkout')
      .sort({ createdAt: -1 })
      .limit(10); // Giới hạn 10 giao dịch gần nhất

    res.status(200).json({
      points: user.points,
      recentTransactions: transactions,
    });
  } catch (error) {
    console.error('Lỗi lấy điểm tích lũy:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi lấy điểm tích lũy', error: error.message });
  }
});

/**
 * @route   GET /api/users/:id/points/history
 * @desc    Lấy lịch sử điểm tích lũy của một người dùng
 * @access  Riêng tư (yêu cầu token, chỉ admin/staff hoặc chính người dùng)
 */
router.get('/:id/points/history', protect, async (req, res) => {
  try {
    const userId = req.params.id;
    const requestingUser = req.user;

    // Kiểm tra quyền: chỉ admin/staff hoặc chính người dùng được truy cập
    if (requestingUser.id !== userId && !['admin', 'staff'].includes(requestingUser.role)) {
      return res.status(403).json({ message: 'Không có quyền truy cập' });
    }

    const user = await User.findById(userId).select('points name email');
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng' });
    }

    // Lấy lịch sử giao dịch liên quan đến điểm
    const transactions = await Transaction.find({ userId })
      .select('points amount bookingId paymentMethod status createdAt')
      .populate('bookingId', 'checkin checkout roomid')
      .sort({ createdAt: -1 });

    res.status(200).json({
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        points: user.points,
      },
      transactions,
    });
  } catch (error) {
    console.error('Lỗi lấy lịch sử điểm:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi lấy lịch sử điểm', error: error.message });
  }
});

// GET /api/users/membership/level/:userId - Lấy cấp độ thành viên
router.get('/membership/level/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'ID người dùng không hợp lệ' });
    }

    const user = await User.findById(userId).select('points');
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng' });
    }

    let membershipLevel;
    if (user.points >= 400000) {
      membershipLevel = 'Diamond';   
    } else if (user.points >= 300000) {
      membershipLevel = 'Platinum';
    } else if (user.points >= 200000) {
      membershipLevel = 'Gold';
    } else if (user.points >= 100000) {
      membershipLevel = 'Silver';
    } else {
      membershipLevel = 'Bronze';
    }

    res.status(200).json({
      userId,
      points: user.points,
      membershipLevel,
    });
  } catch (error) {
    console.error('Lỗi khi lấy cấp độ thành viên:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi lấy cấp độ thành viên', error: error.message });
  }
});

// POST /api/users/points/accumulate - Tích điểm theo số điện thoại
router.post('/points/accumulate', protect, async (req, res) => {
  const { phone, bookingId, amount } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    if (!phone || !bookingId || !amount) {
      return res.status(400).json({ message: 'Vui lòng cung cấp số điện thoại, ID đặt phòng và số tiền' });
    }

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: 'ID đặt phòng không hợp lệ' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Không tìm thấy đặt phòng' });
    }

    if (booking.phone !== phone) {
      return res.status(400).json({ message: 'Số điện thoại không khớp với đặt phòng' });
    }

    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng với số điện thoại này' });
    }

    const pointsEarned = Math.floor(amount / 1000); // 1000 VNĐ = 1 điểm
    user.points += pointsEarned;
    await user.save();

    const transaction = new Transaction({
      userId: user._id,
      bookingId,
      amount,
      pointsEarned,
      paymentMethod: booking.paymentMethod, // Get paymentMethod from booking
      status: 'completed',
    });
    await transaction.save();

    res.status(200).json({
      message: 'Tích điểm thành công',
      pointsEarned,
      totalPoints: user.points,
      transaction,
    });
  } catch (error) {
    console.error('Lỗi khi tích điểm:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi tích điểm', error: error.message });
  }
});

/**
 * @route   GET /api/users/points/:phone
 * @desc    Xem điểm tích lũy theo số điện thoại
 * @access  Riêng tư (yêu cầu token, tất cả vai trò: user, staff, admin)
 */
router.get('/points/:phone', protect, async (req, res) => {
  const { phone } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    const user = await User.findOne({ phone }).select('points name email');
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng với số điện thoại này' });
    }

    const transactions = await Transaction.find({ userId: user._id })
      .select('points amount bookingId createdAt')
      .populate('bookingId', 'checkin checkout')
      .sort({ createdAt: -1 })
      .limit(10);

    res.status(200).json({
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        points: user.points,
      },
      recentTransactions: transactions,
    });
  } catch (error) {
    console.error('Lỗi khi lấy điểm tích lũy:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi lấy điểm tích lũy', error: error.message });
  }
});

/**
 * @route   GET /api/users/spending-history/:userId
 * @desc    Xem lịch sử chi tiêu của người dùng
 * @access  Riêng tư (yêu cầu token, chỉ admin/staff hoặc chính người dùng)
 */
router.get('/spending-history/:userId', protect, async (req, res) => {
  const { userId } = req.params;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'ID người dùng không hợp lệ' });
    }

    const requestingUser = req.user;
    if (requestingUser.id !== userId && !['admin', 'staff'].includes(requestingUser.role)) {
      return res.status(403).json({ message: 'Không có quyền truy cập' });
    }

    const user = await User.findById(userId).select('name email');
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng' });
    }

    const transactions = await Transaction.find({ userId })
      .select('amount bookingId paymentMethod status createdAt points')
      .populate('bookingId', 'checkin checkout roomid')
      .sort({ createdAt: -1 });

    const spendingHistory = transactions.map(transaction => ({
      transactionId: transaction._id,
      amount: transaction.amount,
      pointsEarned: transaction.pointsEarned,
      paymentMethod: transaction.paymentMethod,
      status: transaction.status,
      booking: transaction.bookingId ? {
        bookingId: transaction.bookingId._id,
        checkin: transaction.bookingId.checkin,
        checkout: transaction.bookingId.checkout,
        roomId: transaction.bookingId.roomid,
      } : null,
      createdAt: transaction.createdAt,
    }));

    res.status(200).json({
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
      },
      spendingHistory,
    });
  } catch (error) {
    console.error('Lỗi khi lấy lịch sử chi tiêu:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi lấy lịch sử chi tiêu', error: error.message });
  }
});


//PUT cập nhật hồ sơ người dùng
router.put('/profile', protect, upload.single('avatar'), async (req, res) => {
  try {
    console.log('Request body:', req.body);
    console.log('Request file:', req.file);
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }

    const updates = {
      name: req.body.name || user.name,
      phone: req.body.phone || user.phone,
    };

    if (req.file) {
      if (user.avatar && fs.existsSync(path.join(__dirname, '../', user.avatar))) {
        fs.unlinkSync(path.join(__dirname, '../', user.avatar));
      }
      updates.avatar = `/Uploads/${req.file.filename}`;
    }

    if (req.body.oldPassword && req.body.newPassword) {
      const isMatch = await bcrypt.compare(req.body.oldPassword, user.password);
      if (!isMatch) {
        return res.status(400).json({ message: 'Mật khẩu cũ không đúng' });
      }
      updates.password = await bcrypt.hash(req.body.newPassword, 10);
    }

    const updatedUser = await User.findByIdAndUpdate(req.user.id, updates, {
      new: true,
    }).select('-password');
    const bookingsCount = await Booking.countDocuments({
      email: user.email.toLowerCase(),
    });

    const avatarUrl = updates.avatar
      ? `${req.protocol}://${req.get('host')}${updates.avatar}`
      : user.avatar;

    res.json({ ...updatedUser._doc, bookingsCount, avatar: avatarUrl });
  } catch (error) {
    console.error('Update profile error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

//GET lấy hồ sơ người dùng
router.get('/profile', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }
    const bookingsCount = await Booking.countDocuments({ email: user.email.toLowerCase() });
    res.json({ ...user._doc, bookingsCount });
  } catch (error) {
    console.error('Profile error:', error.message);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

router.get('/allusers', protect, adminOrStaff, async (req, res) => {
  try {
    const users = await User.find({ role: 'user', isDeleted: false }).select('-password');
    res.json(users);
  } catch (error) {
    console.error('Get all users error:', error.message);
    res.status(500).json({ message: error.message });
  }
});

router.put('/:userId', protect, admin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (user) {
      user.name = req.body.name || user.name;
      user.email = req.body.email ? req.body.email.toLowerCase() : user.email;
      user.password = req.body.password ? await bcrypt.hash(req.body.password, 10) : user.password;
      user.isAdmin = req.body.isAdmin !== undefined ? req.body.isAdmin : user.isAdmin;
      user.role = req.body.role || user.role;
      user.phone = req.body.phone || user.phone;

      const updatedUser = await user.save();
      res.json({
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        isAdmin: updatedUser.isAdmin,
        role: updatedUser.role,
        phone: updatedUser.phone,
      });
    } else {
      res.status(404).json({ message: 'Người dùng không tồn tại' });
    }
  } catch (error) {
    console.error('Update user error:', error.message);
    res.status(400).json({ message: error.message });
  }
});

router.post('/staff', protect, admin, async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    const normalizedEmail = email.toLowerCase();
    const userExists = await User.findOne({ email: normalizedEmail });
    if (userExists) {
      return res.status(400).json({ message: 'Email đã tồn tại' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email: normalizedEmail,
      password: hashedPassword,
      isAdmin: false,
      role: 'staff',
      phone,
    });

    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
    });
  } catch (error) {
    console.error('Create staff error:', error.message);
    res.status(400).json({ message: error.message });
  }
});

router.get('/staff', protect, admin, async (req, res) => {
  try {
    const staffMembers = await User.find({ role: 'staff', isDeleted: false }).select('-password');
    res.json(staffMembers);
  } catch (error) {
    console.error('Get staff error:', error.message);
    res.status(500).json({ message: error.message });
  }
});

router.put('/staff/:id', protect, admin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (user && user.role === 'staff') {
      user.name = req.body.name || user.name;
      user.email = req.body.email ? req.body.email.toLowerCase() : user.email;
      user.password = req.body.password ? await bcrypt.hash(req.body.password, 10) : user.password;
      user.phone = req.body.phone || user.phone;

      const updatedUser = await user.save();
      res.json({
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
        phone: updatedUser.phone,
      });
    } else {
      res.status(404).json({ message: 'Nhân viên không tồn tại' });
    }
  } catch (error) {
    console.error('Update staff error:', error.message);
    res.status(400).json({ message: error.message });
  }
});

router.delete('/staff/:id', protect, adminOrStaff, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }
    if (user.role === 'admin') {
      return res.status(403).json({ message: 'Không thể xóa tài khoản admin' });
    }
    user.isDeleted = true;
    await user.save();
    res.json({ message: 'Người dùng đã được đánh dấu là xóa' });
  } catch (error) {
    console.error('Delete user error:', error.message);
    res.status(400).json({ message: error.message });
  }
});

/**
 * @route   GET /api/users/:id/bookings
 * @desc    Lấy danh sách đặt phòng của một người dùng
 * @access  Riêng tư (yêu cầu token, chỉ admin/staff hoặc chính người dùng)
 */
router.get('/:id/bookings', protect, async (req, res) => {
  try {
    const userId = req.params.id;
    const requestingUser = req.user;

    if (requestingUser.id !== userId && !['admin', 'staff'].includes(requestingUser.role)) {
      return res.status(403).json({ message: 'Không được phép' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }

    const bookings = await Booking.find({ email: user.email.toLowerCase() });
    res.json(bookings);
  } catch (error) {
    console.error('Get user bookings error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

router.put('/:id/profile', protect, async (req, res) => {
  try {
    const userId = req.params.id;
    const requestingUser = req.user;

    if (requestingUser.id !== userId && requestingUser.role !== 'admin') {
      return res.status(403).json({ message: 'Không được phép' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }

    const updates = {
      name: req.body.name || user.name,
      phone: req.body.phone || user.phone,
    };

    const updatedUser = await User.findByIdAndUpdate(userId, updates, { new: true }).select('-password');
    res.json(updatedUser);
  } catch (error) {
    console.error('Update user profile error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

router.put('/:id/password', protect, async (req, res) => {
  try {
    const userId = req.params.id;
    const { oldPassword, newPassword } = req.body;

    if (req.user.id !== userId) {
      return res.status(403).json({ message: 'Không được phép' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Mật khẩu cũ không đúng!' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ message: 'Đổi mật khẩu thành công' });
  } catch (error) {
    console.error('Change password error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

router.get('/:id/reviews', protect, async (req, res) => {
  try {
    const userId = req.params.id;
    const requestingUser = req.user;

    if (requestingUser.id !== userId && !['admin', 'staff'].includes(requestingUser.role)) {
      return res.status(403).json({ message: 'Không được phép' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }

    const reviews = await Review.find({ email: user.email.toLowerCase() });
    res.json(reviews);
  } catch (error) {
    console.error('Get user reviews error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

router.get('/stats', protect, admin, async (req, res) => {
  try {
    const { startDate, endDate, region } = req.query;

    let query = { isDeleted: false };

    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }

    if (region) {
      query.region = region;
    }

    const stats = await User.aggregate([
      { $match: query },
      {
        $group: {
          _id: { role: '$role', region: '$region' },
          count: { $sum: 1 },
        },
      },
    ]);

    res.json(stats);
  } catch (error) {
    console.error('Get user stats error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

router.post('/ban', protect, admin, async (req, res) => {
  try {
    const { userId, reason } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }

    if (user.role === 'admin') {
      return res.status(403).json({ message: 'Không thể khóa tài khoản admin' });
    }

    user.isDelete = true; // Khóa tài khoản bằng soft delete
    user.banReason = reason; // Giả định có trường banReason trong schema
    await user.save();

    res.json({ message: 'Khóa tài khoản thành công', banReason: reason });
  } catch (error) {
    console.error('Ban user error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

router.patch('/:id/role', protect, admin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { role } = req.body;

    if (!['user', 'admin', 'staff'].includes(role)) {
      return res.status(400).json({ message: 'Vai trò không hợp lệ' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }

    user.role = role;
    user.isAdmin = role === 'admin';
    await user.save();

    res.json({ message: 'Cập nhật vai trò thành công', role });
  } catch (error) {
    console.error('Update user role error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

router.get('/recent', protect, adminOrStaff, async (req, res) => {
  try {
    const recentUsers = await User.find({ isDeleted: false })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('-password');
    res.json(recentUsers);
  } catch (error) {
    console.error('Get recent users error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

router.get('/frequent', protect, adminOrStaff, async (req, res) => {
  try {
    const frequentUsers = await Booking.aggregate([
      {
        $group: {
          _id: '$email',
          bookingCount: { $sum: 1 },
        },
      },
      { $sort: { bookingCount: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: 'email',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $project: {
          _id: '$user._id',
          name: '$user.name',
          email: '$user.email',
          bookingCount: 1,
        },
      },
    ]);

    res.json(frequentUsers);
  } catch (error) {
    console.error('Get frequent users error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

router.get('/search', protect, adminOrStaff, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ message: 'Yêu cầu từ khóa tìm kiếm' });
    }

    const users = await User.find({
      $or: [
        { name: { $regex: q, $options: 'i' } },
        { email: { $regex: q, $options: 'i' } },
      ],
      isDeleted: false,
    }).select('-password');

    res.json(users);
  } catch (error) {
    console.error('Search users error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

const Notification = require('../models/notification');

router.get('/:id/notifications', protect, async (req, res) => {
  try {
    const userId = req.params.id;
    const requestingUser = req.user;

    if (requestingUser.id !== userId && !['admin', 'staff'].includes(requestingUser.role)) {
      return res.status(403).json({ message: 'Không được phép' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }

    const notifications = await Notification.find({ userId });
    res.json(notifications);
  } catch (error) {
    console.error('Get notifications error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

router.post('/:id/notifications', protect, adminOrStaff, async (req, res) => {
  try {
    const userId = req.params.id;
    const { message, type } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }

    const notification = new Notification({
      userId,
      message,
      type: type || 'info',
    });

    await notification.save();
    res.status(201).json({ message: 'Gửi thông báo thành công', notification });
  } catch (error) {
    console.error('Send notification error:', error.message);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

router.post('/regions/assign-admin', protect, admin, async (req, res) => {
  const { userId, regionId } = req.body;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(regionId)) {
      return res.status(400).json({ message: 'ID người dùng hoặc khu vực không hợp lệ' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng' });
    }

    if (user.role !== 'admin') {
      return res.status(400).json({ message: 'Người dùng phải có vai trò admin' });
    }

    const region = await Region.findById(regionId);
    if (!region) {
      return res.status(404).json({ message: 'Không tìm thấy khu vực' });
    }

    region.adminId = userId;
    user.region = regionId;
    await region.save();
    await user.save();

    res.status(200).json({ message: 'Phân quyền admin khu vực thành công', region, user });
  } catch (error) {
    console.error('Lỗi phân quyền admin khu vực:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi phân quyền admin khu vực', error: error.message });
  }
});

/**
 * @route   GET /api/users/membership/benefits/:userId
 * @desc    Lấy danh sách quyền lợi theo cấp độ thành viên
 * @access  Riêng tư (yêu cầu token)
 */
router.get('/membership/benefits/:userId', protect, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Kết nối cơ sở dữ liệu chưa sẵn sàng' });
    }

    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'ID người dùng không hợp lệ' });
    }

    const user = await User.findById(userId).select('points');
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng' });
    }

    let membershipLevel;
    if (user.points >= 400000) membershipLevel = 'Diamond';
    else if (user.points >= 300000) membershipLevel = 'Platinum';
    else if (user.points >= 200000) membershipLevel = 'Gold';
    else if (user.points >= 100000) membershipLevel = 'Silver';
    else membershipLevel = 'Bronze';

    // Quyền lợi mẫu cho từng cấp độ (có thể lưu trong database hoặc config)
    const benefits = {
      Bronze: ['Ưu đãi cơ bản', 'Tích điểm 1% mỗi giao dịch'],
      Silver: ['Ưu đãi cơ bản', 'Tích điểm 1.5% mỗi giao dịch', 'Miễn phí nâng cấp phòng 1 lần/năm'],
      Gold: ['Ưu đãi cơ bản', 'Tích điểm 2% mỗi giao dịch', 'Miễn phí nâng cấp phòng 2 lần/năm', 'Check-in ưu tiên'],
      Platinum: ['Ưu đãi cơ bản', 'Tích điểm 2.5% mỗi giao dịch', 'Miễn phí nâng cấp phòng 3 lần/năm', 'Check-in ưu tiên', 'Dịch vụ đưa đón sân bay'],
      Diamond: ['Ưu đãi cơ bản', 'Tích điểm 3% mỗi giao dịch', 'Miễn phí nâng cấp phòng không giới hạn', 'Check-in ưu tiên', 'Dịch vụ đưa đón sân bay', 'Quà tặng đặc biệt hàng năm'],
    };

    res.status(200).json({
      userId,
      membershipLevel,
      points: user.points,
      benefits: benefits[membershipLevel],
    });
  } catch (error) {
    console.error('Lỗi khi lấy quyền lợi thành viên:', error.message, error.stack);
    res.status(500).json({ message: 'Lỗi khi lấy quyền lợi thành viên', error: error.message });
  }
});

module.exports = router;