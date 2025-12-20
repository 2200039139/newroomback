const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const winston = require('winston');

require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

// Logger configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Environment variables
const JWT_SECRET = process.env.JWT_SECRET || 'your-jwt-secret-key-change-this';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '37085501976-b54lfva9uchil1jq6boc6vt4jb1bqb5d.apps.googleusercontent.com';

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'https://splitta1.vercel.app','https://credresolvesplitwise.vercel.app'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors()); // Handle preflight requests
app.use(bodyParser.json());

// Database connection
let pool;

async function initializeDatabase() {
  try {
    pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  ssl: {
    rejectUnauthorized: false
  }
});


    // Test connection
    const connection = await pool.getConnection();
    logger.info('Database connected successfully');
    connection.release();

    // Create tables
    await createTables();
  } catch (error) {
    logger.error('Database connection failed:', error);
    process.exit(1);
  }
}

async function createTables() {
  try {
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        fullName VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255),
        googleId VARCHAR(255),
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Roommates table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS roommates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        userId INT NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_userId (userId)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Check if expenses table exists and has splitAmong column
    const [tables] = await pool.query(`
      SHOW TABLES LIKE 'expenses'
    `);
    
    if (tables.length > 0) {
      // Check if splitAmong column exists
      const [columns] = await pool.query(`
        SHOW COLUMNS FROM expenses LIKE 'splitAmong'
      `);
      
      if (columns.length === 0) {
        // Add splitAmong column if it doesn't exist
        await pool.query(`
          ALTER TABLE expenses 
          ADD COLUMN splitAmong JSON AFTER date
        `);
        logger.info('Added splitAmong column to expenses table');
      }
    } else {
      // Create expenses table with splitAmong as JSON
      await pool.query(`
        CREATE TABLE IF NOT EXISTS expenses (
          id INT AUTO_INCREMENT PRIMARY KEY,
          description VARCHAR(255) NOT NULL,
          amount DECIMAL(10, 2) NOT NULL,
          paidBy INT NOT NULL,
          date DATE NOT NULL,
          splitAmong JSON,
          userId INT NOT NULL,
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (paidBy) REFERENCES roommates(id) ON DELETE CASCADE,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_userId (userId),
          INDEX idx_paidBy (paidBy),
          INDEX idx_date (date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    }

    // Settlements table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settlements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        fromId INT NOT NULL,
        toId INT NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        date DATE NOT NULL,
        userId INT NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (fromId) REFERENCES roommates(id) ON DELETE CASCADE,
        FOREIGN KEY (toId) REFERENCES roommates(id) ON DELETE CASCADE,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_userId (userId),
        INDEX idx_fromId (fromId),
        INDEX idx_toId (toId)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    logger.info('Database tables created/updated successfully');
  } catch (error) {
    logger.error('Error creating/updating tables:', error);
  }
}

// JWT Authentication Middleware
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ 
        success: false,
        error: 'Access denied. No token provided.' 
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Verify user still exists in database
    const [users] = await pool.query(
      'SELECT id, fullName, email FROM users WHERE id = ?', 
      [decoded.id]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ 
        success: false,
        error: 'User not found.' 
      });
    }

    req.user = users[0];
    next();
  } catch (error) {
    return res.status(403).json({ 
      success: false,
      error: 'Invalid or expired token.' 
    });
  }
};

// Initialize database
initializeDatabase();

// Helper function to parse splitAmong
const parseSplitAmong = (splitAmongData) => {
  try {
    if (!splitAmongData) return [];
    
    if (typeof splitAmongData === 'string') {
      return JSON.parse(splitAmongData);
    }
    
    if (Array.isArray(splitAmongData)) {
      return splitAmongData;
    }
    
    return [];
  } catch (error) {
    console.error('Error parsing splitAmong:', error);
    return [];
  }
};

// Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true,
    status: 'OK', 
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Test database connection
app.get('/api/test-db', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [result] = await connection.query('SELECT 1 as test');
    connection.release();
    
    res.json({
      success: true,
      message: 'Database connected',
      data: result[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Database connection failed',
      details: error.message
    });
  }
});
// Get detailed splits with paid, owes, and net calculations

// Get detailed splits with paid, owes, and net calculations
// Get detailed splits with paid, owes, and net calculations
// Replace the /api/splits endpoint in your backend with this corrected version

app.get('/api/splits', authenticateToken, async (req, res) => {
  try {
    const [roommates] = await pool.query(
      'SELECT * FROM roommates WHERE userId = ? ORDER BY name ASC',
      [req.user.id]
    );
    
    const [expenses] = await pool.query(
      'SELECT * FROM expenses WHERE userId = ?',
      [req.user.id]
    );
    
    const [settlements] = await pool.query(
      'SELECT * FROM settlements WHERE userId = ?',
      [req.user.id]
    );

    // Initialize splits for all roommates
    const splits = {};
    roommates.forEach(roommate => {
      splits[roommate.id] = {
        id: roommate.id,
        name: roommate.name,
        paid: 0,
        owes: 0,
        net: 0
      };
    });

    // Calculate from expenses
    expenses.forEach(expense => {
      const amount = parseFloat(expense.amount) || 0;
      const paidById = parseInt(expense.paidBy);
      const splitAmongArray = parseSplitAmong(expense.splitAmong);
      const numericSplitAmong = splitAmongArray.map(id => parseInt(id));
      
      // Add to paid amount for payer
      if (splits[paidById]) {
        splits[paidById].paid += amount;
      }

      // Calculate what each roommate owes for this expense
      if (numericSplitAmong.length > 0) {
        const perPersonShare = amount / numericSplitAmong.length;
        
        numericSplitAmong.forEach(roommateId => {
          if (splits[roommateId]) {
            splits[roommateId].owes += perPersonShare;
          }
        });
      }
    });

    // Calculate initial net balance (before settlements)
    Object.values(splits).forEach(split => {
      split.net = split.paid - split.owes;
    });

    // Process settlements - adjust net balances
    // When someone settles a payment, it reduces their debt and increases the receiver's net
    settlements.forEach(settlement => {
      const fromId = parseInt(settlement.fromId);
      const toId = parseInt(settlement.toId);
      const amount = parseFloat(settlement.amount);
      
      // Person who pays settlement: their net balance increases (they owe less)
      if (splits[fromId]) {
        splits[fromId].net += amount;
      }
      
      // Person who receives settlement: their net balance decreases (they're owed less)
      if (splits[toId]) {
        splits[toId].net -= amount;
      }
    });

    // Round all values to 2 decimal places
    Object.values(splits).forEach(split => {
      split.paid = parseFloat(split.paid.toFixed(2));
      split.owes = parseFloat(split.owes.toFixed(2));
      split.net = parseFloat(split.net.toFixed(2));
    });

    // Convert to array for response
    const result = Object.values(splits);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Calculate splits error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error calculating splits' 
    });
  }
});
// User Registration
app.post('/api/users/register', async (req, res) => {
  try {
    const { fullName, email, password } = req.body;

    // Validation
    if (!fullName || !email || !password) {
      return res.status(400).json({ 
        success: false,
        error: 'All fields are required' 
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ 
        success: false,
        error: 'Password must be at least 6 characters long' 
      });
    }

    // Check if user exists
    const [existingUsers] = await pool.query(
      'SELECT id FROM users WHERE email = ?', 
      [email]
    );
    
    if (existingUsers.length > 0) {
      return res.status(400).json({ 
        success: false,
        error: 'User already exists with this email' 
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Insert user
    const [result] = await pool.query(
      'INSERT INTO users (fullName, email, password) VALUES (?, ?, ?)',
      [fullName, email, hashedPassword]
    );

    // Create token
    const token = jwt.sign(
      { id: result.insertId, email, fullName },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: { 
        user: { 
          id: result.insertId, 
          fullName, 
          email 
        },
        token 
      }
    });
  } catch (error) {
    logger.error('Registration error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error during registration' 
    });
  }
});

// User Login
app.post('/api/users/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ 
        success: false,
        error: 'Email and password are required' 
      });
    }

    // Find user
    const [users] = await pool.query(
      'SELECT * FROM users WHERE email = ?', 
      [email]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid credentials' 
      });
    }

    const user = users[0];

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid credentials' 
      });
    }

    // Create token
    const token = jwt.sign(
      { id: user.id, email: user.email, fullName: user.fullName },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: { 
        user: { 
          id: user.id, 
          fullName: user.fullName, 
          email: user.email 
        },
        token 
      }
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error during login' 
    });
  }
});

// Get user profile
app.get('/api/users/me', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      data: req.user
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: 'Server error' 
    });
  }
});

// Roommates Routes
app.get('/api/roommates', authenticateToken, async (req, res) => {
  try {
    const [roommates] = await pool.query(
      'SELECT * FROM roommates WHERE userId = ? ORDER BY name ASC',
      [req.user.id]
    );
    
    res.json({
      success: true,
      data: roommates
    });
  } catch (error) {
    logger.error('Get roommates error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error' 
    });
  }
});

app.post('/api/roommates', authenticateToken, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ 
        success: false,
        error: 'Roommate name is required' 
      });
    }

    const [result] = await pool.query(
      'INSERT INTO roommates (name, userId) VALUES (?, ?)',
      [name.trim(), req.user.id]
    );

    res.status(201).json({
      success: true,
      message: 'Roommate added successfully',
      data: {
        id: result.insertId,
        name: name.trim(),
        userId: req.user.id
      }
    });
  } catch (error) {
    logger.error('Add roommate error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error' 
    });
  }
});

app.delete('/api/roommates/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      'DELETE FROM roommates WHERE id = ? AND userId = ?',
      [id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Roommate not found' 
      });
    }

    res.json({
      success: true,
      message: 'Roommate deleted successfully'
    });
  } catch (error) {
    logger.error('Delete roommate error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error' 
    });
  }
});

// Expenses Routes
app.get('/api/expenses', authenticateToken, async (req, res) => {
  try {
    const [expenses] = await pool.query(
      `SELECT e.*, r.name as paidByName 
       FROM expenses e 
       JOIN roommates r ON e.paidBy = r.id 
       WHERE e.userId = ? 
       ORDER BY e.date DESC, e.id DESC`,
      [req.user.id]
    );

    // Parse splitAmong from JSON string to array
    const parsedExpenses = expenses.map(expense => {
      const splitAmongArray = parseSplitAmong(expense.splitAmong);
      
      // Convert all IDs to numbers
      const numericSplitAmong = splitAmongArray.map(id => parseInt(id));
      
      return {
        ...expense,
        amount: parseFloat(expense.amount),
        date: expense.date.toISOString().split('T')[0],
        splitAmong: numericSplitAmong
      };
    });

    res.json({
      success: true,
      data: parsedExpenses
    });
  } catch (error) {
    logger.error('Get expenses error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error' 
    });
  }
});

app.post('/api/expenses', authenticateToken, async (req, res) => {
  try {
    const { description, amount, paidBy, date, splitAmong } = req.body;

    // Validation
    if (!description || description.trim() === '') {
      return res.status(400).json({ 
        success: false,
        error: 'Description is required' 
      });
    }

    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Valid amount is required' 
      });
    }

    if (!paidBy) {
      return res.status(400).json({ 
        success: false,
        error: 'Paid by is required' 
      });
    }

    if (!date) {
      return res.status(400).json({ 
        success: false,
        error: 'Date is required' 
      });
    }

    // Ensure splitAmong is an array and convert IDs to numbers
    let splitAmongArray = Array.isArray(splitAmong) ? splitAmong : [];
    splitAmongArray = splitAmongArray.map(id => parseInt(id)).filter(id => !isNaN(id));
    
    // Validate that splitAmong is not empty
    if (splitAmongArray.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Select at least one person to split with' 
      });
    }

    // Verify paidBy roommate belongs to user and exists
    const [roommates] = await pool.query(
      'SELECT id FROM roommates WHERE id = ? AND userId = ?',
      [paidBy, req.user.id]
    );

    if (roommates.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid roommate selected' 
      });
    }

    // Store as JSON string
    const splitAmongJSON = JSON.stringify(splitAmongArray);

    const [result] = await pool.query(
      'INSERT INTO expenses (description, amount, paidBy, date, splitAmong, userId) VALUES (?, ?, ?, ?, ?, ?)',
      [description.trim(), parseFloat(amount), parseInt(paidBy), date, splitAmongJSON, req.user.id]
    );

    // Get the newly inserted expense with paidByName
    const [newExpense] = await pool.query(
      `SELECT e.*, r.name as paidByName 
       FROM expenses e 
       JOIN roommates r ON e.paidBy = r.id 
       WHERE e.id = ? AND e.userId = ?`,
      [result.insertId, req.user.id]
    );

    const formattedExpense = newExpense[0] ? {
      ...newExpense[0],
      amount: parseFloat(newExpense[0].amount),
      date: newExpense[0].date.toISOString().split('T')[0],
      splitAmong: splitAmongArray
    } : null;

    res.status(201).json({
      success: true,
      message: 'Expense added successfully',
      data: formattedExpense || {
        id: result.insertId,
        description: description.trim(),
        amount: parseFloat(amount),
        paidBy: parseInt(paidBy),
        date,
        splitAmong: splitAmongArray,
        userId: req.user.id
      }
    });
  } catch (error) {
    logger.error('Add expense error:', error);
    console.error('Full error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error while adding expense' 
    });
  }
});

app.delete('/api/expenses/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      'DELETE FROM expenses WHERE id = ? AND userId = ?',
      [id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Expense not found' 
      });
    }

    res.json({
      success: true,
      message: 'Expense deleted successfully'
    });
  } catch (error) {
    logger.error('Delete expense error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error' 
    });
  }
});

// Settlements Routes
app.get('/api/settlements', authenticateToken, async (req, res) => {
  try {
    const [settlements] = await pool.query(
      `SELECT s.*, r1.name as fromName, r2.name as toName 
       FROM settlements s 
       JOIN roommates r1 ON s.fromId = r1.id 
       JOIN roommates r2 ON s.toId = r2.id 
       WHERE s.userId = ? 
       ORDER BY s.date DESC, s.id DESC`,
      [req.user.id]
    );
    
    // Format settlements
    const formattedSettlements = settlements.map(settlement => ({
      ...settlement,
      amount: parseFloat(settlement.amount),
      date: settlement.date.toISOString().split('T')[0]
    }));
    
    res.json({
      success: true,
      data: formattedSettlements
    });
  } catch (error) {
    logger.error('Get settlements error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error' 
    });
  }
});

app.post('/api/settlements', authenticateToken, async (req, res) => {
  try {
    const { fromId, toId, amount, date } = req.body;

    if (!fromId || !toId) {
      return res.status(400).json({ 
        success: false,
        error: 'Both sender and receiver are required' 
      });
    }

    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Valid amount is required' 
      });
    }

    if (fromId === toId) {
      return res.status(400).json({ 
        success: false,
        error: 'Sender and receiver cannot be the same' 
      });
    }

    if (!date) {
      return res.status(400).json({ 
        success: false,
        error: 'Date is required' 
      });
    }

    // Verify roommates belong to user
    const [roommates] = await pool.query(
      'SELECT id FROM roommates WHERE id IN (?, ?) AND userId = ?',
      [fromId, toId, req.user.id]
    );

    if (roommates.length !== 2) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid roommates selected' 
      });
    }

    const [result] = await pool.query(
      'INSERT INTO settlements (fromId, toId, amount, date, userId) VALUES (?, ?, ?, ?, ?)',
      [parseInt(fromId), parseInt(toId), parseFloat(amount), date, req.user.id]
    );

    // Get the newly inserted settlement
    const [newSettlement] = await pool.query(
      `SELECT s.*, r1.name as fromName, r2.name as toName 
       FROM settlements s 
       JOIN roommates r1 ON s.fromId = r1.id 
       JOIN roommates r2 ON s.toId = r2.id 
       WHERE s.id = ? AND s.userId = ?`,
      [result.insertId, req.user.id]
    );

    const formattedSettlement = newSettlement[0] ? {
      ...newSettlement[0],
      amount: parseFloat(newSettlement[0].amount),
      date: newSettlement[0].date.toISOString().split('T')[0]
    } : null;

    res.status(201).json({
      success: true,
      message: 'Settlement added successfully',
      data: formattedSettlement || {
        id: result.insertId,
        fromId: parseInt(fromId),
        toId: parseInt(toId),
        amount: parseFloat(amount),
        date,
        userId: req.user.id
      }
    });
  } catch (error) {
    logger.error('Add settlement error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error while adding settlement' 
    });
  }
});

// Get balances
app.get('/api/balances', authenticateToken, async (req, res) => {
  try {
    const [roommates] = await pool.query(
      'SELECT * FROM roommates WHERE userId = ?',
      [req.user.id]
    );
    
    const [expenses] = await pool.query(
      'SELECT * FROM expenses WHERE userId = ?',
      [req.user.id]
    );
    
    const [settlements] = await pool.query(
      'SELECT * FROM settlements WHERE userId = ?',
      [req.user.id]
    );

    const balances = {};
    roommates.forEach(roommate => {
      balances[roommate.id] = 0;
    });

    // Calculate from expenses
    expenses.forEach(expense => {
      const splitAmongArray = parseSplitAmong(expense.splitAmong);
      const numericSplitAmong = splitAmongArray.map(id => parseInt(id));
      
      const totalShares = numericSplitAmong.length;
      
      if (totalShares > 0) {
        const shareValue = parseFloat(expense.amount) / totalShares;
        
        numericSplitAmong.forEach(roommateId => {
          if (roommateId === parseInt(expense.paidBy)) {
            balances[roommateId] += parseFloat(expense.amount) - shareValue;
          } else {
            balances[roommateId] -= shareValue;
          }
        });
      }
    });

    // Adjust from settlements
    settlements.forEach(settlement => {
      const fromId = parseInt(settlement.fromId);
      const toId = parseInt(settlement.toId);
      const amount = parseFloat(settlement.amount);
      
      balances[fromId] -= amount;
      balances[toId] += amount;
    });

    const result = roommates.map(roommate => ({
      id: roommate.id,
      name: roommate.name,
      balance: parseFloat(balances[roommate.id] || 0).toFixed(2)
    }));

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Calculate balances error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error' 
    });
  }
});

// Google Authentication
app.post('/api/users/google-auth', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ 
        success: false,
        error: 'Google token is required' 
      });
    }

    const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const { sub: googleId, email, name } = payload;

    if (!email) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid Google token' 
      });
    }

    // Check if user exists
    const [existingUsers] = await pool.query(
      'SELECT * FROM users WHERE googleId = ? OR email = ?',
      [googleId, email]
    );

    let user;
    if (existingUsers.length > 0) {
      user = existingUsers[0];
      
      // Update Google ID if missing
      if (!user.googleId) {
        await pool.query(
          'UPDATE users SET googleId = ? WHERE id = ?',
          [googleId, user.id]
        );
      }
    } else {
      // Create new user
      const [result] = await pool.query(
        'INSERT INTO users (fullName, email, googleId) VALUES (?, ?, ?)',
        [name, email, googleId]
      );
      
      user = {
        id: result.insertId,
        fullName: name,
        email,
        googleId
      };
    }

    // Create JWT token
    const jwtToken = jwt.sign(
      { id: user.id, email: user.email, fullName: user.fullName },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      message: 'Google authentication successful',
      data: { 
        user: { 
          id: user.id, 
          fullName: user.fullName, 
          email: user.email 
        },
        token: jwtToken 
      }
    });
  } catch (error) {
    logger.error('Google auth error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Google authentication failed' 
    });
  }
});

// Dashboard Statistics
app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    const [totalExpenses] = await pool.query(
      'SELECT SUM(amount) as total FROM expenses WHERE userId = ?',
      [req.user.id]
    );
    
    const [totalRoommates] = await pool.query(
      'SELECT COUNT(*) as count FROM roommates WHERE userId = ?',
      [req.user.id]
    );
    
    const [expenseCount] = await pool.query(
      'SELECT COUNT(*) as count FROM expenses WHERE userId = ?',
      [req.user.id]
    );
    
    const [recentExpenses] = await pool.query(
      `SELECT e.*, r.name as paidByName 
       FROM expenses e 
       JOIN roommates r ON e.paidBy = r.id 
       WHERE e.userId = ? 
       ORDER BY e.date DESC 
       LIMIT 5`,
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        totalExpenses: parseFloat(totalExpenses[0]?.total || 0),
        totalRoommates: totalRoommates[0]?.count || 0,
        expenseCount: expenseCount[0]?.count || 0,
        recentExpenses: recentExpenses.map(expense => ({
          ...expense,
          amount: parseFloat(expense.amount),
          date: expense.date.toISOString().split('T')[0],
          splitAmong: parseSplitAmong(expense.splitAmong)
        }))
      }
    });
  } catch (error) {
    logger.error('Dashboard stats error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Server error' 
    });
  }
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ 
    success: false,
    error: 'API endpoint not found' 
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ 
    success: false,
    error: 'Internal server error' 
  });
});

// Start server
app.listen(port, '0.0.0.0', () => {
  logger.info(`Server running on port ${port}`);
  logger.info(`API Base URL: http://localhost:${port}/api`);
});
