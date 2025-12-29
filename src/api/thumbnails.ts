import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  // Upload the Thumbnail
  const formData = await req.formData();
  const thumbnail = formData.get("thumbnail");

  // Check if thumbnail is a File
  if (!(thumbnail instanceof File)) throw new BadRequestError("Thumbnail was not a File.");

  // Check if thumbnail is too big
  const MAX_UPLOAD_SIZE = 10 << 20;
  if (thumbnail.size > MAX_UPLOAD_SIZE) throw new BadRequestError("Thumbnail file size is too big.");

  // Get thumbnail media type
  const mediaType = thumbnail.type;

  // Get thumbnail data
  const thumbnailData = await thumbnail.arrayBuffer();

  // Convert the thumbnail data into a base64 string for insertion into the database
  const thumbnailDataBuffer = Buffer.from(thumbnailData);
  const thumbnailDataString = thumbnailDataBuffer.toString("base64");
  const thumbnailDataUrl = `data:${mediaType};base64,${thumbnailDataString}`;

  // Get and validate the metadata of the video
  const videoMetadata = getVideo(cfg.db, videoId);
  if (!videoMetadata) throw new BadRequestError("Video not found.");
  if (videoMetadata.userID !== userID) throw new UserForbiddenError("Forbidden.");

  // Update metadata
  videoMetadata.thumbnailURL = thumbnailDataUrl;

  // Update video record in database
  updateVideo(cfg.db, videoMetadata);

  return respondWithJSON(200, videoMetadata);
}
