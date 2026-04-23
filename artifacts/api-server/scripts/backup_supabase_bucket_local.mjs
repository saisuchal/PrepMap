#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const sourceUrl = process.env.SOURCE_SUPABASE_URL || process.env.SUPABASE_URL || process.argv[2];
const sourceKey =
  process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.argv[3];
const sourceBucket = process.env.SOURCE_BUCKET || process.env.SUPABASE_STORAGE_BUCKET || "prepmap-files";
const rootPrefix = (process.env.STORAGE_PREFIX ?? "uploads").replace(/^\/+|\/+$/g, "");
const pageSize = Number(process.env.STORAGE_PAGE_SIZE || 1000);
const outputRoot = process.env.STORAGE_BACKUP_DIR || path.resolve("artifacts/api-server/storage-backup");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetDir = path.resolve(outputRoot, `${sourceBucket}-${rootPrefix || "root"}-${stamp}`);

if (!sourceUrl || !sourceKey) {
  console.error("Usage:");
  console.error(
    "  SOURCE_SUPABASE_URL=... SOURCE_SUPABASE_SERVICE_ROLE_KEY=... node scripts/backup_supabase_bucket_local.mjs",
  );
  console.error("or");
  console.error("  node scripts/backup_supabase_bucket_local.mjs <source_url> <source_service_role_key>");
  process.exit(1);
}

const source = createClient(sourceUrl, sourceKey, { auth: { persistSession: false } });

function joinPath(parent, child) {
  if (!parent) return child;
  return `${parent}/${child}`;
}

async function listAllFiles(bucket, prefix) {
  const files = [];
  const queue = [prefix];

  while (queue.length > 0) {
    const current = queue.shift();
    let offset = 0;

    while (true) {
      const { data, error } = await source.storage.from(bucket).list(current, {
        limit: pageSize,
        offset,
      });
      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const item of data) {
        const fullPath = joinPath(current, item.name);
        const isFolder = item.id === null;
        if (isFolder) {
          queue.push(fullPath);
        } else {
          files.push({
            path: fullPath,
            contentType: item.metadata?.mimetype || "application/octet-stream",
            size: Number(item.metadata?.size || 0),
          });
        }
      }

      if (data.length < pageSize) break;
      offset += pageSize;
    }
  }

  return files;
}

async function downloadFile(file) {
  const { data: blob, error } = await source.storage.from(sourceBucket).download(file.path);
  if (error) throw error;

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const dest = path.resolve(targetDir, file.path);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
}

async function run() {
  const startedAt = Date.now();
  await fs.mkdir(targetDir, { recursive: true });

  try {
    const files = await listAllFiles(sourceBucket, rootPrefix);
    console.log(`Found ${files.length} files under ${sourceBucket}/${rootPrefix || ""}`);

    let copied = 0;
    let totalBytes = 0;
    for (const file of files) {
      await downloadFile(file);
      copied += 1;
      totalBytes += file.size;
      if (copied % 25 === 0 || copied === files.length) {
        console.log(`Downloaded ${copied}/${files.length}`);
      }
    }

    const manifestPath = path.resolve(targetDir, "_manifest.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          sourceUrl,
          sourceBucket,
          rootPrefix,
          downloadedAt: new Date().toISOString(),
          fileCount: files.length,
          totalBytes,
          files,
        },
        null,
        2,
      ),
      "utf-8",
    );

    console.log("\nStorage backup complete.");
    console.log(`Output: ${targetDir}`);
    console.log(`Files: ${files.length}`);
    console.log(`Bytes: ${totalBytes}`);
    console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(2)}s`);
  } catch (error) {
    if (error && typeof error === "object") {
      const anyErr = error;
      console.error("Storage backup failed:", {
        message: anyErr.message,
        code: anyErr.code,
        details: anyErr.details,
        hint: anyErr.hint,
      });
    } else {
      console.error("Storage backup failed:", String(error));
    }
    process.exitCode = 1;
  }
}

run();

