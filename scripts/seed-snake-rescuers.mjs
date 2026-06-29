// One-off seed script: merge the 32 Pune Division (MH 12) snake/animal
// rescuers from Wild Animals and Snakes Protection Society (Reg No.
// 63/08) into the canonical directory.json without disturbing whatever
// the UI has saved since the last seed. Also restores the 8 emergency
// contacts if they got wiped by an earlier UI save that didn't echo
// them back.
//
// Usage: node scripts/seed-snake-rescuers.mjs
//
// Safe to re-run: skips entries whose id already exists.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const path = resolve(__dirname, '..', 'config', 'directory.json');
const data = JSON.parse(readFileSync(path, 'utf8'));

const SNAKE_CATEGORY = 'Snake/Animal Rescuer';
const COMMENT =
  'Wild Animals and Snakes Protection Society. Reg No. 63/08 \u2014 ' +
  'Pune Division (MH 12). Volunteer rescuer; no fees, call or petrol charges.';
const NOW = '2026-06-29T00:00:00.000Z';

const rescuers = [
  ['Anand Adsul',      '9860181534'],
  ['Raj Salvi',        '9595519852'],
  ['Sairaj Dhere',     '9689512081'],
  ['Suraj Bhosale',    '8007313030'],
  ['Sai Phadtare',     '7775092373'],
  ['Saurabh Shinde',   '9970542409'],
  ['Prasad Bhopale',   '8408034884'],
  ['Suyash Sutar',     '8805283000'],
  ['Suraj Kavade',     '7385854905'],
  ['Harshad Autade',   '9158844598'],
  ['Anand Narale',     '9156324140'],
  ['Swapnil Autade',   '9823737368'],
  ['Ajay Kondavale',   '7774056078'],
  ['Ritesh Memane',    '8793329616'],
  ['Pramod Kamble',    '9850060576'],
  ['Yogesh Tupe',      '7350755141'],
  ['Ravi Kulte',       '9011249999'],
  ['Sushant Korfade',  '8485898818'],
  ['Tejas Kaduskar',   '9545870147'],
  ['Aniket Jadhav',    '9145304143'],
  ['Omkar Kulkarni',   '8605570109'],
  ['Rajesh Pivar',     '7507275504'],
  ['Sandesh Bhadale',  '9764838686'],
  ['Sagar Dixit',      '9762112113'],
  ['Yuvraj Kondhare',  '9822629822'],
  ['Ashish Salpekar',  '9763078093'],
  ['Kiran Gaykwad',    '9130200309'],
  ['Suresh Sasar',     '9370646825'],
  ['Vishal Jagtap',    '8087716570'],
  ['Sachin Pathak',    '9922494049'],
  ['Sagar Bawale',     '8275133333'],
  ['Santosh Thorat',   '8087348348'],
];

const emergencyDefaults = [
  ['emg-001', 'Mr. Manish Pande', 'Security',         '9975605329', 1],
  ['emg-002', 'Mr. Sachin',       'Housekeeping',     '9623986349', 2],
  ['emg-003', 'Mr. Tiwari',       'Electrician',      '9765550942', 3],
  ['emg-004', 'Mr. Vishwajit',    'Plumber (A Wing)', '9122706433', 4],
  ['emg-005', 'Mr. Sahani',       'Plumber (B Wing)', '8766826634', 5],
  ['emg-006', 'Mr. Guru',         'Plumber (C Wing)', '8766826634', 6],
  ['emg-007', 'Mr. Sambhale',     'Fabricator',       '9922340835', 7],
  ['emg-008', 'Mr. Ajit',         'CCTV / Camera',    '7058456042', 8],
];

data.serviceCategories ??= [];
if (!data.serviceCategories.includes(SNAKE_CATEGORY)) {
  data.serviceCategories.unshift(SNAKE_CATEGORY);
}

data.services ??= [];
const existingIds = new Set(data.services.map((s) => s.id));
let added = 0;
rescuers.forEach(([name, phone], idx) => {
  const id = `svc-snake-${String(idx + 1).padStart(3, '0')}`;
  if (existingIds.has(id)) return;
  data.services.push({
    id,
    name,
    category: SNAKE_CATEGORY,
    phones: [phone],
    phone,
    comment: COMMENT,
    sortOrder: idx + 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  added++;
});

data.emergency ??= [];
const emgIds = new Set(data.emergency.map((e) => e.id));
let restored = 0;
emergencyDefaults.forEach(([id, name, role, phone, sortOrder]) => {
  if (emgIds.has(id)) return;
  data.emergency.push({
    id,
    name,
    role,
    phones: [phone],
    phone,
    sortOrder,
    createdAt: NOW,
    updatedAt: NOW,
  });
  restored++;
});
data.emergency.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log(
  `services: ${data.services.length} (+${added} snake rescuers) | ` +
  `serviceCategories: ${data.serviceCategories.length} | ` +
  `emergency: ${data.emergency.length} (+${restored} restored)`,
);
