const express = require('express');
const webpush = require('web-push');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const multer = require('multer');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer config for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `notif-img-${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Initialize Local JSON Database
function initDb() {
  if (fs.existsSync(DB_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
      // Verify structure
      if (data.subscriptions && data.settings && data.vapidKeys && data.notificationHistory) {
        return data;
      }
    } catch (e) {
      console.error("Error reading db.json, recreating it:", e);
    }
  }

  // Generate new VAPID keys if database is new
  const vapidKeys = webpush.generateVAPIDKeys();
  const defaultDb = {
    subscriptions: [],
    settings: {
      adsterraLink: "https://example.com/adsterra-direct-link",
      redirectOnBlock: true,
      landingPageMessage: "Click Allow to verify you are not a robot"
    },
    vapidKeys: {
      publicKey: vapidKeys.publicKey,
      privateKey: vapidKeys.privateKey
    },
    notificationHistory: []
  };

  fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb, null, 2), 'utf-8');
  return defaultDb;
}

// Load database state
let db = initDb();

// Set VAPID Details
webpush.setVapidDetails(
  'mailto:admin@mintcode.co',
  db.vapidKeys.publicKey,
  db.vapidKeys.privateKey
);

// Save DB state helper
function saveDb() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

// ==================== API ENDPOINTS ====================

// 1. Get configuration for landing page
app.get('/api/config', (req, res) => {
  res.json({
    vapidPublicKey: db.vapidKeys.publicKey,
    landingPageMessage: db.settings.landingPageMessage,
    redirectOnBlock: db.settings.redirectOnBlock,
    adsterraLink: db.settings.adsterraLink
  });
});

// 2. Register/Subscribe user to push notifications
app.post('/api/subscribe', (req, res) => {
  const { subscription } = req.body;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Invalid subscription object" });
  }

  // Check if subscription already exists
  const exists = db.subscriptions.find(sub => sub.endpoint === subscription.endpoint);
  if (!exists) {
    db.subscriptions.push(subscription);
    saveDb();
    console.log(`New subscriber registered! Total: ${db.subscriptions.length}`);
  }

  res.status(201).json({ success: true });
});

// 3. Admin Get Stats
app.get('/api/admin/stats', (req, res) => {
  res.json({
    totalSubscribers: db.subscriptions.length,
    history: db.notificationHistory
  });
});

// 4. Admin Get Settings
app.get('/api/admin/settings', (req, res) => {
  res.json(db.settings);
});

// 5. Admin Update Settings
app.post('/api/admin/settings', (req, res) => {
  const { adsterraLink, redirectOnBlock, landingPageMessage } = req.body;

  if (adsterraLink !== undefined) db.settings.adsterraLink = adsterraLink;
  if (redirectOnBlock !== undefined) db.settings.redirectOnBlock = redirectOnBlock;
  if (landingPageMessage !== undefined) db.settings.landingPageMessage = landingPageMessage;

  saveDb();
  res.json({ success: true, settings: db.settings });
});

// 6. Admin Send Notification Campaign
app.post('/api/admin/send', async (req, res) => {
  const { title, body, icon, image, url } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: "Title and Body are required" });
  }

  const notificationPayload = JSON.stringify({
    title,
    body,
    icon: icon || '/img/default-icon.png',
    image: image || '',
    url: url || db.settings.adsterraLink
  });

  console.log(`Starting notification campaign: "${title}"`);
  
  let successCount = 0;
  let failureCount = 0;
  const invalidSubscriptions = [];

  // Send notifications to all subscribers in parallel
  const sendPromises = db.subscriptions.map(async (subscription, index) => {
    try {
      await webpush.sendNotification(subscription, notificationPayload);
      successCount++;
    } catch (error) {
      failureCount++;
      // Clean up dead/unsubscribed push endpoints
      if (error.statusCode === 410 || error.statusCode === 404) {
        invalidSubscriptions.push(subscription.endpoint);
      }
      console.error(`Failed to send to subscriber ${index}: Code ${error.statusCode}`);
    }
  });

  await Promise.all(sendPromises);

  // Remove dead subscriptions from database
  if (invalidSubscriptions.length > 0) {
    db.subscriptions = db.subscriptions.filter(
      sub => !invalidSubscriptions.includes(sub.endpoint)
    );
    console.log(`Cleaned up ${invalidSubscriptions.length} expired subscriptions.`);
  }

  // Save to notification history
  const campaignRecord = {
    id: Date.now().toString(),
    title,
    body,
    url: url || db.settings.adsterraLink,
    successCount,
    failureCount,
    date: new Date().toISOString()
  };
  
  db.notificationHistory.unshift(campaignRecord); // Add to beginning
  saveDb();

  res.json({
    success: true,
    stats: {
      success: successCount,
      failed: failureCount,
      totalRemaining: db.subscriptions.length
    }
  });
});

// 7. Image Upload Endpoint
app.post('/api/admin/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  // Return the public URL for the uploaded image
  const imageUrl = `/uploads/${req.file.filename}`;
  res.json({ success: true, url: imageUrl });
});

// 8. Delete uploaded image
app.delete('/api/admin/delete-image', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename required' });

  const filePath = path.join(UPLOADS_DIR, path.basename(filename));
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Push Notification Server running on http://localhost:${PORT}`);
});
