const mongoose = require('mongoose');

/**
 * Connects to MongoDB using the MONGODB_URI environment variable.
 * Exits the process with a clear error message when the connection fails
 * (e.g. MongoDB is not running) so the administrator knows exactly what to fix.
 */
async function connectDB() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polling_system';

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`[DB] MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
  } catch (error) {
    console.error('[DB] MongoDB connection failed.');
    console.error('[DB] Make sure MongoDB is running and MONGODB_URI is correct.');
    console.error(`[DB] Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = connectDB;