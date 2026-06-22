// API configuration
const config = {
  // Use relative path in production, localhost in development
  apiBaseUrl: process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001',
};

export default config;
