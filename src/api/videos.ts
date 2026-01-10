import { respondWithJSON } from "./json";

import type { ApiConfig } from "../config";
import type { BunRequest, S3File } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import path from "path";
import { randomBytes } from "crypto";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  // Authenticate the User
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  // Get and validate the metadata of the video
  const videoMetadata = getVideo(cfg.db, videoId);
  if (!videoMetadata) throw new NotFoundError("Video not found.");
  if (videoMetadata.userID !== userID) throw new UserForbiddenError("Forbidden.");

  // Get the video data from the form data
  const formData = await req.formData();
  const video = formData.get("video");

  // Check if video is a File
  if (!(video instanceof File)) throw new BadRequestError("Thumbnail was not a File.");

  // Check if thumbnail is too big
  if (video.size > MAX_UPLOAD_SIZE) throw new BadRequestError("Thumbnail file size is too big.");

  // Get video media type
  const mediaType = video.type;
  if (!(mediaType === "video/mp4")) throw new BadRequestError(`Bad File Type.`);

  // Temporarily save the thumbnail to the file system
  const fileName = `${randomBytes(32).toString("base64url")}.${video.type.slice(video.type.indexOf("/") + 1)}`;
  const filePath = path.join(cfg.assetsRoot, fileName);
  await Bun.write(filePath, video);

  // Get the thumbnail's aspect ratio
  const aspectRatio = await getVideoAspectRatio(filePath);
  const fileNameWithAspectRatio = `${aspectRatio}/${fileName}`;

  // Write the file to S3
  const fileOnS3: S3File = cfg.s3Client.file(fileNameWithAspectRatio);
  await fileOnS3.write(Bun.file(filePath), {
    type: video.type,
  });

  // Update the videoMetaData with the S3 URL for the file
  videoMetadata.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileNameWithAspectRatio}`;

  // Update video record in database
  updateVideo(cfg.db, videoMetadata);

  // Remove the temporary file from the file system
  await Bun.file(filePath).delete();

  return respondWithJSON(200, null);
}

export async function getVideoAspectRatio(filePath: string) {
  // Run ffprobe on the file at filePath and aquire the results
  const subprocess = Bun.spawn(["ffprobe", "-v", "error", "-select_streams",
    "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Handle Errors
  if (await subprocess.exited != 0) {
    const errorText = await new Response(subprocess.stderr).text();
    throw new Error(errorText);
  }

  // Find and return Aspect Ratio
  const outputText = await new Response(subprocess.stdout).text();
  const parsedOutputText = JSON.parse(outputText);
  if (typeof parsedOutputText !== "object" ||
    parsedOutputText === null ||
    typeof parsedOutputText.streams !== "object"
  ) throw new Error(`Video metadata JSON doesn't match expected format.`);

  const streamZero = parsedOutputText.streams[0];
  if (typeof streamZero.width !== "number" ||
    typeof streamZero.height !== "number"
  ) throw new Error(`Video metadata JSON doesn't match expected format.`);

  /* function getGreatestCommonDenominator(a: number, b: number): number {
    return b === 0 ? a : getGreatestCommonDenominator(b, a % b);
  };

  const gcd = streamZero.height > streamZero.width ?
  getGreatestCommonDenominator(streamZero.height, streamZero.width):
  getGreatestCommonDenominator(streamZero.width, streamZero.height);
  const aspectRatio = (streamZero.height / gcd) / (streamZero.width / gcd); */

  const aspectRatio = streamZero.height / streamZero.width;
  const portrait = 16 / 9; // 1.777777777777778
  const landscape = 9 / 16; // 0.5625
  const tolerance = 0.01;



  if (Math.abs(aspectRatio - portrait) < tolerance) return "portrait";
  if (Math.abs(aspectRatio - landscape) < tolerance) return "landscape";
  return "other";
}