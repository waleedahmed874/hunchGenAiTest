const mongoose = require('mongoose');

/**
 * MongoDB connection configuration
 * Uses connection pooling and handles reconnection automatically
 */
class Database {
  constructor() {
    this.connection = null;
  }

  /**
   * Connect to MongoDB
   * @returns {Promise<void>}
   */
  async connect() {
    try {
      // Support both MONGODB_URI (full URI) or MONGODB_URL + DATABASE_NAME
      let mongoUri = process.env.MONGODB_URI;
      if (!mongoUri) {
        const mongoUrl = process.env.MONGODB_URL || 'mongodb://localhost:27017';
        const dbName = process.env.DATABASE_NAME || 'hunchGenAiTest';
        mongoUri = `${mongoUrl}/${dbName}`;
      }
      
      const options = {
        maxPoolSize: 10, // Maintain up to 10 socket connections
        serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
        socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
        family: 4 // Use IPv4, skip trying IPv6
      };

      this.connection = await mongoose.connect(mongoUri, options);
      
      console.log('✅ MongoDB connected successfully');
      console.log(`   Database: ${this.connection.connection.name}`);
      console.log(`   Host: ${this.connection.connection.host}`);
      
      // Handle connection events
      mongoose.connection.on('error', (err) => {
        console.error('❌ MongoDB connection error:', err);
      });

      mongoose.connection.on('disconnected', () => {
        console.warn('⚠️  MongoDB disconnected');
      });

      mongoose.connection.on('reconnected', () => {
        console.log('✅ MongoDB reconnected');
      });

      // Graceful shutdown
      process.on('SIGINT', this.disconnect.bind(this));
      process.on('SIGTERM', this.disconnect.bind(this));

      return this.connection;
    } catch (error) {
      console.error('❌ MongoDB connection failed:', error.message);
      throw error;
    }
  }

  /**
   * Disconnect from MongoDB
   * @returns {Promise<void>}
   */
  async disconnect() {
    try {
      if (this.connection) {
        await mongoose.connection.close();
        console.log('✅ MongoDB disconnected gracefully');
      }
    } catch (error) {
      console.error('❌ Error disconnecting from MongoDB:', error.message);
      throw error;
    }
  }

  /**
   * Get connection status
   * @returns {string}
   */
  getStatus() {
    return mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  }
}

// Create singleton instance
const database = new Database();

module.exports = database;

