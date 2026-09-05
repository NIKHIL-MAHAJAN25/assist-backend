const cloudinary = require('../config/cloudinary');

async function uploadFrame(base64Image, mimeType = 'image/jpeg') {
  const result = await cloudinary.uploader.upload(`data:${mimeType};base64,${base64Image}`, {
    folder: 'assist/frames',
  });
  return result.public_id;
}

async function deleteImage(publicId) {
  await cloudinary.uploader.destroy(publicId);
}

module.exports = { uploadFrame, deleteImage };
