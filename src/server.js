import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { getDb, migrate } from './db.js';
import fs from 'fs';
import path from 'path';
import multer from 'multer';

const app = express();
const port = process.env.PORT || 3000;
const jwtSecret = process.env.JWT_SECRET || 'vesper-secret-key';
const dataDir = './data';
const uploadDir = path.join(dataDir, 'uploads');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static(uploadDir));

function authenticate(required = true) {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    if (!header) {
      if (required) return res.status(401).json({ error: 'Missing token' });
      return next();
    }
    const token = header.replace('Bearer ', '');
    try {
      const payload = jwt.verify(token, jwtSecret);
      req.user = payload;
      return next();
    } catch (err) {
      if (required) return res.status(401).json({ error: 'Invalid token' });
      next();
    }
  };
}

function requireAdmin(level = 'admin') {
  return async (req, res, next) => {
    if (!req.user) return res.status(403).json({ error: 'Not authorized' });
    if (req.user.role === 'root') return next();
    if (level === 'admin' && (req.user.role === 'admin' || req.user.role === 'root')) return next();
    if (level === 'developer' && ['developer', 'admin', 'root'].includes(req.user.role)) return next();
    return res.status(403).json({ error: 'Insufficient role' });
  };
}

function logAction(db, actorId, action, target, detail) {
  return db.run(
    'INSERT INTO audit_log (id, actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    uuid(), actorId || null, action, target, detail, Date.now()
  );
}

function isPrivileged(user, level = 'developer') {
  if (!user) return false;
  if (user.role === 'root') return true;
  if (level === 'admin') return ['admin', 'root'].includes(user.role);
  if (level === 'developer') return ['developer', 'admin', 'root'].includes(user.role);
  return false;
}

async function bootstrap() {
  await migrate();
  const db = await getDb();

  app.post('/api/auth/send-code', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const verificationCode = String(Math.floor(100000 + Math.random() * 900000));
    const expiry = Date.now() + 10 * 60 * 1000;
    const existing = await db.get('SELECT id FROM users WHERE email = ?', email);
    if (existing) {
      await db.run('UPDATE users SET verification_code = ?, verification_expires = ? WHERE email = ?', verificationCode, expiry, email);
    } else {
      await db.run(
        'INSERT INTO users (id, email, password_hash, nickname, verified, created_at, updated_at, verification_code, verification_expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        uuid(), email, '', '访客', 0, Date.now(), Date.now(), verificationCode, expiry
      );
    }
    res.json({ message: 'Verification code issued', codePreview: process.env.NODE_ENV === 'development' ? verificationCode : undefined });
  });

  app.post('/api/auth/register', async (req, res) => {
    const { email, password, nickname, verificationCode, developerCode, deviceFingerprint } = req.body;
    if (!email || !password || !nickname || !verificationCode) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const user = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (!user || user.verification_code !== verificationCode || Date.now() > (user.verification_expires || 0)) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }
    if (user.password_hash) {
      return res.status(400).json({ error: 'Account already exists' });
    }
    const hash = await bcrypt.hash(password, 10);
    const now = Date.now();
    let devCodeRow = null;
    if (developerCode) {
      devCodeRow = await db.get('SELECT * FROM developer_codes WHERE code = ? AND is_active = 1', developerCode);
      if (!devCodeRow || devCodeRow.bound_user_id) {
        return res.status(400).json({ error: 'Developer code unavailable' });
      }
    }
    await db.run(
      'UPDATE users SET password_hash = ?, nickname = ?, verified = 1, updated_at = ?, device_fingerprint = COALESCE(device_fingerprint, ?) WHERE email = ?',
      hash, nickname, now, deviceFingerprint || null, email
    );
    let role = 'user';
    if (devCodeRow) {
      role = devCodeRow.level === 'root' ? 'root' : devCodeRow.level;
      await db.run('UPDATE developer_codes SET bound_user_id = ?, bound_at = ? WHERE id = ?', user.id, now, devCodeRow.id);
      await db.run(
        'UPDATE users SET developer_code_id = ?, is_admin = CASE WHEN ? IN ("admin","root") THEN 1 ELSE is_admin END, is_root = CASE WHEN ? = "root" THEN 1 ELSE is_root END WHERE id = ?',
        devCodeRow.id,
        devCodeRow.level,
        devCodeRow.level,
        user.id
      );
    }
    const token = jwt.sign({ id: user.id, email, role }, jwtSecret, { expiresIn: '12h' });
    await logAction(db, user.id, 'register', email, 'User registration completed');
    res.json({ token, role });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (!user || !user.password_hash) return res.status(400).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
    const role = user.is_root ? 'root' : user.is_admin ? 'admin' : user.developer_code_id ? 'developer' : 'user';
    const token = jwt.sign({ id: user.id, email, role }, jwtSecret, { expiresIn: '12h' });
    res.json({ token, role, nickname: user.nickname, vipLevel: user.vip_level, vipExpiry: user.vip_expiry });
  });

  app.post('/api/auth/forgot', async (req, res) => {
    const { email } = req.body;
    const user = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (!user) return res.status(400).json({ error: 'Unknown account' });
    const resetCode = String(Math.floor(100000 + Math.random() * 900000));
    const expiry = Date.now() + 10 * 60 * 1000;
    await db.run('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?', resetCode, expiry, user.id);
    res.json({ message: 'Reset code issued', codePreview: process.env.NODE_ENV === 'development' ? resetCode : undefined });
  });

  app.post('/api/auth/reset', async (req, res) => {
    const { email, resetCode, password } = req.body;
    const user = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (!user || user.reset_token !== resetCode || Date.now() > (user.reset_expires || 0)) {
      return res.status(400).json({ error: 'Invalid reset request' });
    }
    const hash = await bcrypt.hash(password, 10);
    await db.run('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?', hash, user.id);
    res.json({ message: 'Password reset' });
  });

  app.post('/api/developer/bind', authenticate(), async (req, res) => {
    const { developerCode } = req.body;
    const userRow = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!developerCode) return res.status(400).json({ error: 'Code required' });
    const codeRow = await db.get('SELECT * FROM developer_codes WHERE code = ? AND is_active = 1', developerCode);
    if (!codeRow || codeRow.bound_user_id) return res.status(400).json({ error: 'Code not available' });
    await db.run('UPDATE developer_codes SET bound_user_id = ?, bound_at = ? WHERE id = ?', userRow.id, Date.now(), codeRow.id);
    await db.run(
      'UPDATE users SET developer_code_id = ?, is_admin = CASE WHEN ? IN ("admin","root") THEN 1 ELSE is_admin END, is_root = CASE WHEN ? = "root" THEN 1 ELSE is_root END WHERE id = ?',
      codeRow.id,
      codeRow.level,
      codeRow.level,
      userRow.id
    );
    const role = codeRow.level === 'root' ? 'root' : codeRow.level;
    const token = jwt.sign({ id: userRow.id, email: userRow.email, role }, jwtSecret, { expiresIn: '12h' });
    await logAction(db, userRow.id, 'bind_code', codeRow.code, 'Developer identity bound');
    res.json({ token, role });
  });

  app.post('/api/developer/generate', authenticate(), requireAdmin('developer'), async (req, res) => {
    const { level = 'developer', quantity = 1, note, customCode, unlimited } = req.body;
    const codes = [];
    for (let i = 0; i < quantity; i += 1) {
      const codeValue = customCode && i === 0 ? customCode : `DEV-${level}-${uuid().slice(0, 8)}`;
      const id = uuid();
      await db.run(
        'INSERT INTO developer_codes (id, code, level, generated_by, is_active, created_at, max_generations, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, codeValue, level, req.user.id, 1, Date.now(), unlimited ? null : 1, note || null
      );
      codes.push(codeValue);
    }
    await logAction(db, req.user.id, 'generate_codes', `${quantity}`, `Level ${level}`);
    res.json({ codes });
  });

  app.get('/api/developer/codes', authenticate(), requireAdmin('admin'), async (req, res) => {
    const rows = await db.all('SELECT * FROM developer_codes');
    res.json(rows);
  });

  app.post('/api/developer/revoke', authenticate(), requireAdmin('admin'), async (req, res) => {
    const { code } = req.body;
    await db.run('UPDATE developer_codes SET is_active = 0 WHERE code = ?', code);
    await logAction(db, req.user.id, 'revoke_code', code, 'Code revoked');
    res.json({ message: 'Revoked' });
  });

  app.get('/api/icons', authenticate(false), async (_req, res) => {
    const groups = await db.all('SELECT * FROM icon_groups ORDER BY position');
    const icons = await db.all('SELECT * FROM icons ORDER BY position');
    res.json({ groups, icons });
  });

  app.post('/api/icons/group', authenticate(), requireAdmin('developer'), async (req, res) => {
    const { name, position = 0 } = req.body;
    const id = uuid();
    await db.run('INSERT INTO icon_groups (id, name, position, created_by) VALUES (?, ?, ?, ?)', id, name, position, req.user.id);
    res.json({ id, name, position });
  });

  app.post('/api/icons', authenticate(), requireAdmin('developer'), async (req, res) => {
    const { groupId, title, url, image, position = 0 } = req.body;
    const id = uuid();
    await db.run('INSERT INTO icons (id, group_id, title, url, image, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', id, groupId, title, url, image, position, req.user.id);
    res.json({ id });
  });

  app.put('/api/icons/:id', authenticate(), requireAdmin('developer'), async (req, res) => {
    const { title, url, image, position, groupId } = req.body;
    await db.run('UPDATE icons SET title = ?, url = ?, image = ?, position = ?, group_id = ? WHERE id = ?', title, url, image, position, groupId, req.params.id);
    res.json({ message: 'Updated' });
  });

  app.delete('/api/icons/:id', authenticate(), requireAdmin('developer'), async (req, res) => {
    await db.run('DELETE FROM icons WHERE id = ?', req.params.id);
    res.json({ message: 'Removed' });
  });

  app.get('/api/knowledge', authenticate(false), async (_req, res) => {
    const blocks = await db.all('SELECT * FROM knowledge_blocks ORDER BY position');
    res.json(blocks);
  });

  app.post('/api/knowledge', authenticate(), requireAdmin('developer'), async (req, res) => {
    const { category, title, content, position = 0 } = req.body;
    const id = uuid();
    await db.run('INSERT INTO knowledge_blocks (id, category, title, content, created_by, position) VALUES (?, ?, ?, ?, ?, ?)', id, category, title, content, req.user.id, position);
    res.json({ id });
  });

  app.put('/api/knowledge/:id', authenticate(), requireAdmin('developer'), async (req, res) => {
    const { category, title, content, position } = req.body;
    await db.run('UPDATE knowledge_blocks SET category = ?, title = ?, content = ?, position = ? WHERE id = ?', category, title, content, position, req.params.id);
    res.json({ message: 'Updated' });
  });

  app.delete('/api/knowledge/:id', authenticate(), requireAdmin('developer'), async (req, res) => {
    await db.run('DELETE FROM knowledge_blocks WHERE id = ?', req.params.id);
    res.json({ message: 'Removed' });
  });

  app.post('/api/files/upload', authenticate(), upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'File missing' });
    const id = uuid();
    await db.run(
      'INSERT INTO files (id, owner_id, original_name, stored_name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      req.user.id,
      req.file.originalname,
      req.file.filename,
      req.file.mimetype,
      req.file.size,
      Date.now()
    );
    await logAction(db, req.user.id, 'upload_file', req.file.originalname, req.file.filename);
    res.json({ id, url: `/uploads/${req.file.filename}` });
  });

  app.get('/api/files', authenticate(false), async (req, res) => {
    const { user } = req;
    const params = [];
    let query = 'SELECT * FROM files WHERE visibility = "public"';
    if (user) {
      if (isPrivileged(user, 'admin')) {
        query = 'SELECT * FROM files';
      } else {
        query = 'SELECT * FROM files WHERE visibility = "public" OR owner_id = ?';
        params.push(user.id);
      }
    }
    const files = await db.all(`${query} ORDER BY created_at DESC`, ...params);
    res.json(files.map((f) => ({ ...f, url: `/uploads/${f.stored_name}` })));
  });

  app.post('/api/files/:id/meta', authenticate(), async (req, res) => {
    const file = await db.get('SELECT * FROM files WHERE id = ?', req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.owner_id !== req.user.id && !isPrivileged(req.user, 'admin')) return res.status(403).json({ error: 'Denied' });
    const { visibility = 'private', tags = '' } = req.body;
    await db.run('UPDATE files SET visibility = ?, tags = ? WHERE id = ?', visibility, tags, file.id);
    res.json({ message: 'Updated' });
  });

  app.get('/api/notes', authenticate(false), async (req, res) => {
    const { user } = req;
    const params = [];
    let query = 'SELECT * FROM notes WHERE visibility = "public"';
    if (user) {
      if (isPrivileged(user, 'admin')) {
        query = 'SELECT * FROM notes';
      } else {
        query = 'SELECT * FROM notes WHERE visibility = "public" OR owner_id = ?';
        params.push(user.id);
      }
    }
    const rows = await db.all(`${query} ORDER BY updated_at DESC`, ...params);
    res.json(rows);
  });

  app.post('/api/notes', authenticate(), async (req, res) => {
    const { title, content, tags, visibility = 'private' } = req.body;
    const id = uuid();
    const now = Date.now();
    await db.run(
      'INSERT INTO notes (id, owner_id, title, content, tags, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      req.user.id,
      title,
      content,
      tags || '',
      visibility,
      now,
      now
    );
    res.json({ id });
  });

  app.put('/api/notes/:id', authenticate(), async (req, res) => {
    const note = await db.get('SELECT * FROM notes WHERE id = ?', req.params.id);
    if (!note) return res.status(404).json({ error: 'Not found' });
    if (note.owner_id !== req.user.id && !isPrivileged(req.user, 'admin')) return res.status(403).json({ error: 'Denied' });
    const { title, content, tags, visibility } = req.body;
    await db.run(
      'UPDATE notes SET title = ?, content = ?, tags = ?, visibility = ?, updated_at = ? WHERE id = ?',
      title,
      content,
      tags || '',
      visibility || note.visibility,
      Date.now(),
      note.id
    );
    res.json({ message: 'Updated' });
  });

  app.delete('/api/notes/:id', authenticate(), async (req, res) => {
    const note = await db.get('SELECT * FROM notes WHERE id = ?', req.params.id);
    if (!note) return res.status(404).json({ error: 'Not found' });
    if (note.owner_id !== req.user.id && !isPrivileged(req.user, 'admin')) return res.status(403).json({ error: 'Denied' });
    await db.run('DELETE FROM notes WHERE id = ?', note.id);
    res.json({ message: 'Removed' });
  });

  app.get('/api/posts', authenticate(false), async (req, res) => {
    const { user } = req;
    let rows;
    if (user && isPrivileged(user, 'developer')) {
      rows = await db.all('SELECT * FROM posts ORDER BY created_at DESC');
    } else if (user) {
      rows = await db.all('SELECT * FROM posts WHERE status = "published" OR author_id = ? ORDER BY created_at DESC', user.id);
    } else {
      rows = await db.all('SELECT * FROM posts WHERE status = "published" ORDER BY created_at DESC');
    }
    res.json(rows);
  });

  app.post('/api/posts', authenticate(), requireAdmin('developer'), async (req, res) => {
    const { title, content, status = 'draft' } = req.body;
    const id = uuid();
    const now = Date.now();
    await db.run('INSERT INTO posts (id, author_id, title, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, req.user.id, title, content, status, now, now);
    res.json({ id });
  });

  app.put('/api/posts/:id', authenticate(), async (req, res) => {
    const post = await db.get('SELECT * FROM posts WHERE id = ?', req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    if (!isPrivileged(req.user, 'developer') && post.author_id !== req.user.id) return res.status(403).json({ error: 'Denied' });
    const { title, content, status } = req.body;
    await db.run('UPDATE posts SET title = ?, content = ?, status = ?, updated_at = ? WHERE id = ?', title, content, status || post.status, Date.now(), post.id);
    res.json({ message: 'Updated' });
  });

  app.delete('/api/posts/:id', authenticate(), requireAdmin('developer'), async (req, res) => {
    await db.run('DELETE FROM posts WHERE id = ?', req.params.id);
    res.json({ message: 'Removed' });
  });

  app.get('/api/tools', authenticate(false), async (_req, res) => {
    const tools = await db.all('SELECT * FROM tools ORDER BY created_at DESC');
    res.json(tools);
  });

  app.post('/api/tools', authenticate(), requireAdmin('developer'), async (req, res) => {
    const { name, url, description, category } = req.body;
    const id = uuid();
    await db.run('INSERT INTO tools (id, name, category, url, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, name, category, url, description, req.user.id, Date.now());
    res.json({ id });
  });

  app.put('/api/tools/:id', authenticate(), requireAdmin('developer'), async (req, res) => {
    const { name, url, description, category } = req.body;
    await db.run('UPDATE tools SET name = ?, category = ?, url = ?, description = ? WHERE id = ?', name, category, url, description, req.params.id);
    res.json({ message: 'Updated' });
  });

  app.delete('/api/tools/:id', authenticate(), requireAdmin('developer'), async (req, res) => {
    await db.run('DELETE FROM tools WHERE id = ?', req.params.id);
    res.json({ message: 'Removed' });
  });

  app.get('/api/clips', authenticate(false), async (req, res) => {
    const { user } = req;
    if (!user) {
      const publicClips = await db.all('SELECT * FROM clips WHERE visibility = "public" ORDER BY created_at DESC');
      return res.json(publicClips);
    }
    if (isPrivileged(user, 'admin')) {
      const rows = await db.all('SELECT * FROM clips ORDER BY created_at DESC');
      return res.json(rows);
    }
    const rows = await db.all('SELECT * FROM clips WHERE visibility = "public" OR user_id = ? ORDER BY created_at DESC', user.id);
    res.json(rows);
  });

  app.post('/api/clips', authenticate(), async (req, res) => {
    const { title, sourceUrl, excerpt, content, tags, visibility = 'private' } = req.body;
    const id = uuid();
    await db.run(
      'INSERT INTO clips (id, user_id, title, source_url, excerpt, content, tags, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      req.user.id,
      title,
      sourceUrl,
      excerpt,
      content,
      tags || '',
      visibility,
      Date.now()
    );
    res.json({ id });
  });

  app.put('/api/clips/:id', authenticate(), async (req, res) => {
    const clip = await db.get('SELECT * FROM clips WHERE id = ?', req.params.id);
    if (!clip) return res.status(404).json({ error: 'Not found' });
    if (clip.user_id !== req.user.id && !isPrivileged(req.user, 'admin')) return res.status(403).json({ error: 'Denied' });
    const { title, sourceUrl, excerpt, content, tags, visibility } = req.body;
    await db.run(
      'UPDATE clips SET title = ?, source_url = ?, excerpt = ?, content = ?, tags = ?, visibility = ? WHERE id = ?',
      title,
      sourceUrl,
      excerpt,
      content,
      tags || '',
      visibility || clip.visibility,
      clip.id
    );
    res.json({ message: 'Updated' });
  });

  app.delete('/api/clips/:id', authenticate(), async (req, res) => {
    const clip = await db.get('SELECT * FROM clips WHERE id = ?', req.params.id);
    if (!clip) return res.status(404).json({ error: 'Not found' });
    if (clip.user_id !== req.user.id && !isPrivileged(req.user, 'admin')) return res.status(403).json({ error: 'Denied' });
    await db.run('DELETE FROM clips WHERE id = ?', clip.id);
    res.json({ message: 'Removed' });
  });

  app.post('/api/coupons', authenticate(), requireAdmin('admin'), async (req, res) => {
    const { code, type, value, durationDays, uses } = req.body;
    const id = uuid();
    await db.run(
      'INSERT INTO coupons (id, code, type, value, duration_days, uses_remaining, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, code || `CP-${uuid().slice(0, 6)}`, type, value, durationDays || null, uses || 1, req.user.id, Date.now()
    );
    res.json({ id });
  });

  app.post('/api/vip/purchase', authenticate(), async (req, res) => {
    const { plan, channel, coupon } = req.body;
    const plans = { month: 60, season: 150, year: 360 };
    const amount = plans[plan];
    if (!amount) return res.status(400).json({ error: 'Unknown plan' });
    let couponRow = null;
    let finalAmount = amount;
    if (coupon) {
      couponRow = await db.get('SELECT * FROM coupons WHERE code = ? AND uses_remaining != 0', coupon);
      if (couponRow) {
        if (couponRow.type === 'discount') finalAmount = Math.ceil(amount * (couponRow.value / 100));
        if (couponRow.type === 'free') finalAmount = 0;
      }
    }
    const orderId = uuid();
    await db.run(
      'INSERT INTO vip_orders (id, user_id, plan, amount, channel, status, created_at, updated_at, coupon_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      orderId, req.user.id, plan, finalAmount, channel, finalAmount === 0 ? 'paid' : 'pending', Date.now(), Date.now(), couponRow ? couponRow.id : null
    );
    if (couponRow) {
      await db.run('UPDATE coupons SET uses_remaining = CASE WHEN uses_remaining IS NULL THEN NULL ELSE uses_remaining - 1 END WHERE id = ?', couponRow.id);
    }
    if (finalAmount === 0) {
      const expiry = plan === 'month' ? 30 : plan === 'season' ? 90 : 365;
      await db.run('UPDATE users SET vip_level = ?, vip_expiry = ? WHERE id = ?', plan, Date.now() + expiry * 24 * 60 * 60 * 1000, req.user.id);
    }
    res.json({ orderId, payable: finalAmount });
  });

  app.post('/api/vip/confirm', async (req, res) => {
    const { orderId, success } = req.body;
    const order = await db.get('SELECT * FROM vip_orders WHERE id = ?', orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (success) {
      const expiry = order.plan === 'month' ? 30 : order.plan === 'season' ? 90 : 365;
      await db.run('UPDATE vip_orders SET status = ?, updated_at = ? WHERE id = ?', 'paid', Date.now(), orderId);
      await db.run('UPDATE users SET vip_level = ?, vip_expiry = ? WHERE id = ?', order.plan, Date.now() + expiry * 24 * 60 * 60 * 1000, order.user_id);
    }
    res.json({ status: success ? 'paid' : 'pending' });
  });

  app.get('/api/admin/users', authenticate(), requireAdmin('admin'), async (_req, res) => {
    const users = await db.all('SELECT id, email, nickname, vip_level, vip_expiry, status, developer_code_id, is_admin FROM users');
    res.json(users);
  });

  app.post('/api/admin/status', authenticate(), requireAdmin('admin'), async (req, res) => {
    const { userId, status } = req.body;
    await db.run('UPDATE users SET status = ? WHERE id = ?', status, userId);
    res.json({ message: 'Status updated' });
  });

  app.get('/api/audit', authenticate(), requireAdmin('admin'), async (_req, res) => {
    const logs = await db.all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');
    res.json(logs);
  });

  app.get('/api/search', authenticate(false), async (req, res) => {
    const { q = '' } = req.query;
    const like = `%${q}%`;
    const icons = await db.all('SELECT title, url FROM icons WHERE title LIKE ? OR url LIKE ? LIMIT 20', like, like);
    const tools = await db.all('SELECT name, url FROM tools WHERE name LIKE ? OR description LIKE ? LIMIT 20', like, like);
    const posts = await db.all('SELECT title, status FROM posts WHERE title LIKE ? OR content LIKE ? LIMIT 20', like, like);
    const clips = await db.all('SELECT title, source_url FROM clips WHERE title LIKE ? OR content LIKE ? LIMIT 20', like, like);
    res.json({ icons, tools, posts, clips });
  });

  app.get('*', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
  });

  app.listen(port, () => {
    console.log(`Vesper Nexus server running on port ${port}`);
  });
}

bootstrap();
