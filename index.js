import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";
import { fileURLToPath } from "url";
import path from "path";
import {
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import multer from "multer";
import { Readable } from "stream";

// Load environment variables from .env file
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

const upload = multer();

const bucketName = process.env.BUCKET_NAME;

async function bucketExists(bucketName) {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    return true;
  } catch (err) {
    if (err.name === "NotFound") {
      return false;
    }
    throw err;
  }
}

async function setupBucket() {
  try {
    const exists = await bucketExists(bucketName);
    if (!exists) {
      // Create the bucket
      await s3Client.send(new CreateBucketCommand({ Bucket: bucketName }));
      console.log(`Bucket ${bucketName} created successfully`);
    } else {
      console.log(`Bucket ${bucketName} already exists`);
    }

    // Configure CORS
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
  } catch (err) {
    console.error("Error setting up bucket:", err);
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/upload-url", async (req, res) => {
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: `uploads/${Date.now()}-${req.query.filename}`,
    ContentType: req.query.contentType,
  });

  try {
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 120 });
    res.json({ uploadUrl: signedUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error generating presigned URL" });
  }
});

app.get("/download-url", async (req, res) => {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: req.query.filename,
  });

  try {
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 120 });
    res.json({ downloadUrl: signedUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error generating presigned URL" });
  }
});

app.get("/list", async (req, res) => {
  const command = new ListObjectsCommand({
    Bucket: bucketName,
  });

  try {
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
  } catch (err) {
    console.error(err);
    if (err.name === "NoSuchBucket") {
      res.status(404).json({ error: "The specified bucket does not exist" });
    } else {
      res
        .status(500)
        .json({ error: "Error listing objects", details: err.message });
    }
  }
});

app.post("/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: `uploads/${Date.now()}-${file.originalname}`,
    Body: file.buffer,
    ContentType: file.mimetype,
  });

  try {
    await s3Client.send(command);
    res.json({ message: "File uploaded successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error uploading file" });
  }
});

// Direct download route
app.get("/download", async (req, res) => {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: req.query.filename,
  });

  try {
    const data = await s3Client.send(command);
    res.setHeader("Content-Type", data.ContentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${req.query.filename}"`
    );
    const stream = Readable.from(data.Body);
    stream.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error downloading file" });
  }
});

app.listen(port, async () => {
  await setupBucket();
  console.log(`Server running at http://localhost:${port}`);
});