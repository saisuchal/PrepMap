import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET;

function getClient() {
  if (!SUPABASE_URL) {
    throw new Error("SUPABASE_URL not set");
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getBucket() {
  if (!SUPABASE_STORAGE_BUCKET) {
    throw new Error("SUPABASE_STORAGE_BUCKET not set");
  }
  return SUPABASE_STORAGE_BUCKET;
}

function normalizeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function isSupabaseStorageEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && SUPABASE_STORAGE_BUCKET);
}

export function isSupabaseStorageRequested() {
  return Boolean(SUPABASE_URL || SUPABASE_SERVICE_ROLE_KEY || SUPABASE_STORAGE_BUCKET);
}

export function isSupabaseObjectPath(path: string) {
  return path.startsWith("/supabase/");
}

export async function createSupabaseSignedUploadUrl(params: { name: string }) {
  const client = getClient();
  const bucket = getBucket();
  const objectPath = `uploads/${randomUUID()}_${normalizeName(params.name || "file.bin")}`;

  const { data, error } = await client.storage.from(bucket).createSignedUploadUrl(objectPath);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Failed to create Supabase signed upload URL");
  }

  const uploadURL = data.signedUrl.startsWith("http")
    ? data.signedUrl
    : `${SUPABASE_URL}/storage/v1${data.signedUrl}`;

  return {
    uploadURL,
    objectPath: `/supabase/${bucket}/${objectPath}`,
  };
}

export async function downloadSupabaseObject(path: string): Promise<{ buffer: Buffer; contentType: string }> {
  if (!isSupabaseObjectPath(path)) {
    throw new Error("Not a Supabase object path");
  }

  const parts = path.replace(/^\/supabase\//, "").split("/");
  if (parts.length < 2) {
    throw new Error("Invalid Supabase object path");
  }

  const bucket = parts[0];
  const objectPath = parts.slice(1).join("/");
  const client = getClient();
  const { data, error } = await client.storage.from(bucket).download(objectPath);
  if (error || !data) {
    throw new Error(error?.message || "Failed to download Supabase object");
  }

  const arrayBuffer = await data.arrayBuffer();
  const contentType = data.type || "application/octet-stream";
  return { buffer: Buffer.from(arrayBuffer), contentType };
}
