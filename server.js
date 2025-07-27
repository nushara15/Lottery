// Import the express framework for building the web server
const express = require('express');
// Import sqlite3 for interacting with the SQLite database
const sqlite3 = require('sqlite3').verbose();
// Import path for handling file and directory paths
const path = require('path');
// Import body-parser to parse incoming JSON request bodies
const bodyParser = require('body-parser');
// Import multer for handling file uploads (like images)
const multer = require('multer');

// Create an Express application
const app = express();
// Set the port number for the server
const PORT = 3000;

// Set up and connect to the SQLite database file (db.sqlite)
const db = new sqlite3.Database('./db.sqlite', (err) => {
  if (err) {
    // If there is an error connecting, print it
    console.error('Could not connect to database', err);
  } else {
    // If connection is successful, print a message
    console.log('Connected to SQLite database');
  }
});

// Create the lottery tables if they don't exist
db.serialize(() => {
  // Articles table (existing)
  db.run(`CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tickets table for lottery purchases
  db.run(`CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT NOT NULL,
    selected_numbers TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    receipt_image TEXT,
    purchase_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmation_date DATETIME
  )`);

  // Winning numbers table
  db.run(`CREATE TABLE IF NOT EXISTS winning_numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numbers TEXT NOT NULL,
    draw_date DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Set up multer for handling image uploads
const storage = multer.diskStorage({
  // Set the destination folder for uploaded files
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'public', 'uploads'));
  },
  // Set the filename for uploaded files to be unique
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname); // Get the file extension
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});
// Create the multer upload middleware using the storage settings above
const upload = multer({ storage: storage });

// Use body-parser middleware to parse JSON request bodies
app.use(bodyParser.json());
// Serve static files (HTML, JS, CSS, images) from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint to get all articles
app.get('/api/articles', (req, res) => {
  // Query the database for all articles, ordered by creation date (newest first)
  db.all('SELECT * FROM articles ORDER BY created_at DESC', [], (err, rows) => {
    if (err) {
      // If there is a database error, send a 500 error response
      res.status(500).json({ error: err.message });
      return;
    }
    // Send the list of articles as JSON
    res.json(rows);
  });
});

// API endpoint to add a new article (with optional image upload)
app.post('/api/articles', upload.single('image'), (req, res) => {
  // Get the title and content from the form data
  const { title, content } = req.body;
  let image = null; // Default to no image
  // If an image was uploaded, set the image path
  if (req.file) {
    image = 'uploads/' + req.file.filename;
  }
  // If title or content is missing, send a 400 error
  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content are required' });
  }
  // Insert the new article into the database, including the image filename if present
  db.run('INSERT INTO articles (title, content, image) VALUES (?, ?, ?)', [title, content, image], function(err) {
    if (err) {
      // If there is a database error, send a 500 error response
      return res.status(500).json({ error: err.message });
    }
    // Send back the new article's id, title, content, and image filename
    res.json({ id: this.lastID, title, content, image });
  });
});

// Lottery API Endpoints

// Submit new ticket purchase
app.post('/api/tickets', upload.single('receipt'), (req, res) => {
  const { phone, numbers } = req.body;
  let receipt = null;
  
  if (req.file) {
    receipt = 'uploads/' + req.file.filename;
  }
  
  if (!phone || !numbers) {
    return res.status(400).json({ error: 'Phone and numbers are required' });
  }
  
  db.run('INSERT INTO tickets (user_phone, selected_numbers, receipt_image) VALUES (?, ?, ?)', 
    [phone, numbers, receipt], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ 
      id: this.lastID, 
      phone, 
      numbers: JSON.parse(numbers), 
      status: 'pending',
      receipt 
    });
  });
});

// Get all tickets (admin)
app.get('/api/tickets', (req, res) => {
  const status = req.query.status;
  let query = 'SELECT * FROM tickets ORDER BY purchase_date DESC';
  let params = [];
  
  if (status) {
    query = 'SELECT * FROM tickets WHERE status = ? ORDER BY purchase_date DESC';
    params = [status];
  }
  
  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows.map(row => ({
      ...row,
      selected_numbers: JSON.parse(row.selected_numbers)
    })));
  });
});

// Get user tickets by phone
app.get('/api/user-tickets/:phone', (req, res) => {
  const phone = req.params.phone;
  db.all('SELECT * FROM tickets WHERE user_phone = ? ORDER BY purchase_date DESC', 
    [phone], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows.map(row => ({
      ...row,
      selected_numbers: JSON.parse(row.selected_numbers)
    })));
  });
});

// Confirm ticket
app.put('/api/tickets/:id/confirm', (req, res) => {
  const id = req.params.id;
  db.run('UPDATE tickets SET status = ?, confirmation_date = CURRENT_TIMESTAMP WHERE id = ?', 
    ['confirmed', id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true });
  });
});

// Reject ticket
app.put('/api/tickets/:id/reject', (req, res) => {
  const id = req.params.id;
  db.run('UPDATE tickets SET status = ? WHERE id = ?', ['rejected', id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true });
  });
});

// Set winning numbers (admin)
app.post('/api/winning-numbers', (req, res) => {
  const { numbers, drawDate } = req.body;
  
  if (!numbers || numbers.length !== 4) {
    return res.status(400).json({ error: 'Exactly 4 numbers required' });
  }
  
  db.run('INSERT INTO winning_numbers (numbers, draw_date) VALUES (?, ?)', 
    [JSON.stringify(numbers), drawDate], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ id: this.lastID, numbers, drawDate });
  });
});

// Get latest winning numbers
app.get('/api/winning-numbers/latest', (req, res) => {
  db.get('SELECT * FROM winning_numbers ORDER BY created_at DESC LIMIT 1', [], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (row) {
      res.json({
        ...row,
        numbers: JSON.parse(row.numbers)
      });
    } else {
      res.json(null);
    }
  });
});

// Clear winning numbers (admin)
app.delete('/api/winning-numbers/clear', (req, res) => {
  db.run('DELETE FROM winning_numbers', [], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true, message: 'All winning numbers cleared' });
  });
});

// Start the server and listen on the specified port
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
}); 