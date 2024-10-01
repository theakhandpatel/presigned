import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsCommand,
} from "@aws-sdk/client-s3";
import { fileURLToPath } from "url";
import path from "path";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import busboy from "busboy";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, "public")));

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const bucketName = process.env.BUCKET_NAME;

async function setupBucket() {
  const exists = await s3Client.send(new HeadBucketCommand({ Bucket: bucketName })).then(() => true).catch(() => false);
  
  if (!exists) {
    await s3Client.send(new CreateBucketCommand({ Bucket: bucketName }));
    console.log(`Bucket ${bucketName} created successfully`);
  } else {
    console.log(`Bucket ${bucketName} already exists`);
  }

  const corsConfiguration = {
    Bucket: bucketName,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedHeaders: ["*"],
          AllowedMethods: ["GET", "PUT", "POST"],
          AllowedOrigins: ["http://localhost:3000"],
          ExposeHeaders: [],
          MaxAgeSeconds: 3000,
        },
      ],
    },
  };
  await s3Client.send(new PutBucketCorsCommand(corsConfiguration));
  console.log(`CORS configuration applied to bucket ${bucketName}`);
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "An error occurred", details: err.message });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/upload-url", async (req, res, next) => {
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: `uploads/${Date.now()}-${req.query.filename}`,
    ContentType: req.query.contentType,
  });

  const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 120 });
  res.json({ uploadUrl: signedUrl });
});

app.get("/download-url", async (req, res, next) => {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: req.query.filename,
  });

  const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 120 });
  res.json({ downloadUrl: signedUrl });
});

app.get("/list", async (req, res, next) => {
  const command = new ListObjectsCommand({
    Bucket: bucketName,
  });

  const data = await s3Client.send(command);
  if (data.Contents && data.Contents.length > 0) {
    const objects = data.Contents.map((obj) => ({
      key: obj.Key,
      size: obj.Size,
      lastModified: obj.LastModified,
    }));
    res.json({ objects });
  } else {
    res.json({ message: "The bucket is empty", objects: [] });
  }
});

app.post("/upload", (req, res, next) => {
  const bb = busboy({ headers: req.headers }); // Initialize busboy with request headers

  bb.on('file', (name, file, info) => {
    const { filename, mimeType } = info;
    const key = `uploads/${Date.now()}-${filename}`; // Generate unique key for the file

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucketName,
        Key: key, 
        Body: file,
        ContentType: mimeType,
      },
    });

    upload.done()
      .then(() => {
        res.json({ message: "File uploaded successfully", key: key });
      })
      .catch(next);
  });

  bb.on('error', next); // Forward busboy errors to the error handling middleware

  req.pipe(bb);
});

app.get("/download", async (req, res, next) => {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: req.query.filename,
  });

  const { Body, ContentType, ContentLength } = await s3Client.send(command);
  
  // Set the response headers for the file download
  res.setHeader("Content-Type", ContentType);
  res.setHeader("Content-Length", ContentLength);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${req.query.filename}"`
  );

  // Pipe the file body to the response
  Body.pipe(res);
});

app.listen(port, async () => {
  await setupBucket();
  console.log(`Server running at http://localhost:${port}`);
});