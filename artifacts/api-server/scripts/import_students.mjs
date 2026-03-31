#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import bcrypt from "bcrypt";

const { Pool } = pg;

const fileArg = process.argv[2];
if (!fileArg) {
  console.error("Usage: node scripts/import_students.mjs <path-to-tsv-or-csv> [branch]");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required in environment.");
  process.exit(1);
}

const branchArg = (process.argv[3] || "CSE").trim();
const filePath = path.resolve(process.cwd(), fileArg);
if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const content = fs.readFileSync(filePath, "utf8");
const rawLines = content
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const splitLine = (line) => {
  if (line.includes("\t")) return line.split("\t");
  if (line.includes(",")) return line.split(",");
  return line.split(/\s{2,}/);
};

const parseYear = (semValue) => {
  const match = semValue.match(/(\d+)/);
  return match?.[1] ?? "1";
};

const rows = rawLines.map((line) => splitLine(line).map((x) => x.trim())).filter((parts) => parts.length >= 2);
if (rows.length === 0) {
  console.error("No valid rows found. Expected at least: id, name, universityName, universityId, semester");
  process.exit(1);
}

const normalizeHeader = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const firstRow = rows[0] ?? [];
const normalizedFirstRow = firstRow.map(normalizeHeader);
const hasHeader =
  normalizedFirstRow.includes("id") &&
  (normalizedFirstRow.includes("university_id") || normalizedFirstRow.includes("universityid"));

const headerMap = new Map();
if (hasHeader) {
  normalizedFirstRow.forEach((h, i) => headerMap.set(h, i));
}

const dataRows = hasHeader ? rows.slice(1) : rows;
const getByHeader = (parts, keys) => {
  for (const key of keys) {
    const idx = headerMap.get(key);
    if (typeof idx === "number" && idx >= 0 && idx < parts.length) {
      return String(parts[idx] || "").trim();
    }
  }
  return "";
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  let imported = 0;
  for (const parts of dataRows) {
    let studentId = "";
    let studentName = null;
    let universityId = "";
    let year = "1";
    let branch = branchArg;
    let role = "student";

    if (hasHeader) {
      studentId = getByHeader(parts, ["id"]);
      studentName = getByHeader(parts, ["name", "student_name"]) || null;
      universityId = getByHeader(parts, ["university_id", "universityid"]);
      const yearRaw = getByHeader(parts, ["year", "semester", "sem"]);
      if (yearRaw) year = parseYear(yearRaw);
      const branchRaw = getByHeader(parts, ["branch"]);
      if (branchRaw) branch = branchRaw;
      const roleRaw = getByHeader(parts, ["role"]);
      if (roleRaw) role = roleRaw.toLowerCase();
      const accountTypeRaw = getByHeader(parts, ["account_type", "accounttype"]);
      if (accountTypeRaw && accountTypeRaw.toLowerCase() === "super_student") role = "super_student";
    } else {
      // Backward-compatible format:
      // id, name, universityName, universityId, semester
      studentId = parts[0];
      studentName = parts[1] || null;
      universityId = parts[3];
      const semesterLabel = parts[4] || "Sem 1";
      year = parseYear(semesterLabel);
      branch = branchArg;
      role = "student";
    }

    if (!studentId || !universityId) continue;

    const hashed = await bcrypt.hash(studentId, 10);

    await pool.query(
      `
      INSERT INTO public.users
      (id, name, university_id, branch, year, role, password, must_reset_password, security_question, security_answer_hash, last_password_reset_at)
      VALUES
      ($1, $2, $3, $4, $5, $6, $7, true, NULL, NULL, NULL)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        university_id = EXCLUDED.university_id,
        branch = EXCLUDED.branch,
        year = EXCLUDED.year,
        role = EXCLUDED.role,
        password = EXCLUDED.password,
        must_reset_password = true,
        security_question = NULL,
        security_answer_hash = NULL,
        last_password_reset_at = NULL
      `,
      [studentId, studentName, universityId, branch, year, role, hashed],
    );
    imported += 1;
  }

  console.log(`Imported ${imported} students.`);
  console.log("Initial password = student ID. First login setup will be required.");
} finally {
  await pool.end();
}
