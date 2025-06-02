const mongoose = require("mongoose");

const roomSchema = mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  maxcount: {
    type: Number,
    required: true,
  },
  beds: {
    type: Number,
    required: true,
  },
  baths: {
    type: Number,
    required: true,
  },
  phonenumber: {
    type: Number,
    required: true,
  },
  rentperday: {
    type: Number,
    required: true,
  },
  imageurls: [],
  currentbookings: [
    {
      bookingId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Booking',
      },
      checkin: {
        type: Date,
        required: true,
      },
      checkout: {
        type: Date,
        required: true,
      },
    },
  ],
  availabilityStatus: {
    type: String,
    enum: ['available', 'maintenance', 'busy'],
    default: 'available',
  },
  type: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
  hotelId: {
    type:String,
  }
}, {
  timestamps: true,
});

const roomModel = mongoose.model('Room', roomSchema);

module.exports = roomModel;