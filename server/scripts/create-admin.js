#!/usr/bin/env node
// Create an admin user: `npm run create-admin` (or `DB_PATH=... node server/scripts/create-admin.js`)
// Prompts for username + password (password input hidden on a TTY).
// Also works with piped input: printf 'user\npass\npass\n' | npm run create-admin
// Refuses if the username exists.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import readline from 'node:readline';
import { openDb } from '../db.js';
import { migrate } from '../migrate.js';
import { hashPassword } from '../password.js';

function readPipedLines() {
  return new Promise((resolveP) => {
    let data = '';
    const stdin = process.stdin;
    stdin.setEncoding('utf8');
    stdin.on('data', (c) => {
      data += c;
    });
    stdin.on('end', () => resolveP(data.split(/\r?\n/)));
    stdin.resume();
  });
}

function askHiddenTTY(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolveP) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.pause();
      stdin.setRawMode(false);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          cleanup();
          process.stdout.write('\n');
          resolveP(buf);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(1);
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function askVisibleTTY(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveP) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolveP(answer);
    });
  });
}

async function main() {
  let username;
  let password;
  let confirm;
  if (process.stdin.isTTY) {
    username = (await askVisibleTTY('اسم المستخدم (admin username): ')).trim();
    password = await askHiddenTTY('كلمة المرور (10 أحرف على الأقل): ');
    confirm = await askHiddenTTY('تأكيد كلمة المرور: ');
  } else {
    const lines = await readPipedLines();
    username = (lines[0] || '').trim();
    password = lines[1] || '';
    confirm = lines[2] || '';
  }

  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    console.error('خطأ: اسم المستخدم يجب أن يكون 3-32 حرفاً (لاتينية/أرقام/._-)');
    process.exit(1);
  }

  const db = openDb();
  migrate(db);
  const exists = db.prepare('SELECT 1 FROM admins WHERE username = ?').get(username);
  if (exists) {
    db.close();
    console.error(`خطأ: المستخدم "${username}" موجود مسبقاً — لم يتم إنشاء حساب جديد`);
    process.exit(1);
  }

  if (password.length < 10) {
    db.close();
    console.error('خطأ: كلمة المرور يجب أن تكون 10 أحرف على الأقل');
    process.exit(1);
  }
  if (confirm !== password) {
    db.close();
    console.error('خطأ: كلمتا المرور غير متطابقتين');
    process.exit(1);
  }

  db.prepare('INSERT INTO admins (username, pw_hash, created_at) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), new Date().toISOString());
  db.close();
  console.log(`تم إنشاء المدير "${username}" بنجاح`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('خطأ:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
