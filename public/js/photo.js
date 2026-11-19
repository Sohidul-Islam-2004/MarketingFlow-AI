// Choosing a photo in the browser and making it smaller before upload (max 1200px, JPEG),
// so product photos stay small in the database and send fast on Messenger.
export function pickPhoto() {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" });
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

export async function shrinkPhoto(file, max = 1200) {
  if (!file || !file.type.startsWith("image/")) throw new Error("Choose a photo (JPG or PNG)");
  const img = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // transparent PNGs get a white background
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}
