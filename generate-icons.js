#!/usr/bin/env node

// Script to generate placeholder PNG icons for Chrome extension
// Generates proper sized icons (16x16, 48x48, 128x128) with a simple design

const fs = require('fs');
const path = require('path');

const iconSizes = [16, 48, 128];
const outputDir = path.join(__dirname, 'icons');

// Create icons directory if it doesn't exist
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

iconSizes.forEach(size => {
  const fileName = `icon${size}.png`;
  const filePath = path.join(outputDir, fileName);
  
  // Create a proper sized PNG with a simple colored square design
  const pngBuffer = createIconPNG(size);
  
  fs.writeFileSync(filePath, pngBuffer);
  console.log(`Created ${fileName} (${size}x${size})`);
});

function createIconPNG(size) {
  // Create RGBA pixel data
  const pixelData = Buffer.alloc(size * size * 4);
  
  // Colors
  const bgColor = { r: 66, g: 133, b: 244 };      // Google Blue
  const formColor = { r: 255, g: 255, b: 255 };   // White
  const aiColor = { r: 255, g: 193, b: 7 };       // Amber/Gold for AI sparkle
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      
      // Normalize coordinates to 0-1
      const nx = x / size;
      const ny = y / size;
      
      // Default: blue background
      let r = bgColor.r, g = bgColor.g, b = bgColor.b;
      
      // Draw a document/form shape in the center
      // Form rectangle area
      const formLeft = 0.2, formRight = 0.8;
      const formTop = 0.15, formBottom = 0.75;
      
      // Check if inside form area
      if (nx >= formLeft && nx <= formRight && ny >= formTop && ny <= formBottom) {
        // White form background
        r = formColor.r; g = formColor.g; b = formColor.b;
        
        // Draw form lines (horizontal lines representing text fields)
        const lineSpacing = 0.12;
        const lineStart = 0.3;
        const lineEnd = 0.7;
        const lineY1 = formTop + 0.15;
        const lineY2 = lineY1 + lineSpacing;
        const lineY3 = lineY2 + lineSpacing;
        
        // Line thickness
        const lineThick = 1.5 / size;
        
        // Check if on a line
        const onLine1 = Math.abs(ny - lineY1) < lineThick && nx >= lineStart && nx <= lineEnd;
        const onLine2 = Math.abs(ny - lineY2) < lineThick && nx >= lineStart && nx <= lineEnd;
        const onLine3 = Math.abs(ny - lineY3) < lineThick && nx >= lineStart && nx <= lineEnd;
        
        if (onLine1 || onLine2 || onLine3) {
          r = 200; g = 200; b = 200; // Gray lines
        }
        
        // Draw checkbox
        const checkboxX = 0.28;
        const checkboxY = lineY3 + lineSpacing;
        const checkboxSize = 0.08;
        
        if (nx >= checkboxX && nx <= checkboxX + checkboxSize && 
            ny >= checkboxY && ny <= checkboxY + checkboxSize) {
          // Checkbox border
          const borderThick = 1.0 / size;
          const inBorder = nx < checkboxX + borderThick || nx > checkboxX + checkboxSize - borderThick ||
                          ny < checkboxY + borderThick || ny > checkboxY + checkboxSize - borderThick;
          
          if (inBorder) {
            r = 66; g = 133; b = 244; // Blue border
          } else {
            // Checkmark inside checkbox
            const cx = (nx - checkboxX) / checkboxSize;
            const cy = (ny - checkboxY) / checkboxSize;
            // Simple checkmark shape
            const checkmark = (cx > 0.2 && cx < 0.5 && cy > 0.4 + cx * 0.5 && cy < 0.6 + cx * 0.5) ||
                             (cx >= 0.5 && cx < 0.8 && cy > 1.2 - cx * 0.8 && cy < 1.4 - cx * 0.8);
            
            if (checkmark) {
              r = 34; g = 197; b = 94; // Green checkmark
            } else {
              r = formColor.r; g = formColor.g; b = formColor.b;
            }
          }
        }
      }
      
      // Draw AI sparkle/star in top-right corner
      const starX = 0.75, starY = 0.25;
      const starSize = 0.15;
      const dx = nx - starX;
      const dy = ny - starY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < starSize) {
        // Star shape: 4-pointed star
        const angle = Math.atan2(dy, dx);
        const starRadius = starSize * (0.6 + 0.4 * Math.cos(4 * angle));
        
        if (dist < starRadius) {
          r = aiColor.r; g = aiColor.g; b = aiColor.b;
        }
      }
      
      // Rounded corners for the whole icon (clip to circle)
      const centerDist = Math.sqrt((nx - 0.5) ** 2 + (ny - 0.5) ** 2);
      if (centerDist > 0.48) {
        // Outside rounded corner - make transparent or background
        const alpha = Math.max(0, 1 - (centerDist - 0.48) * 50);
        if (alpha <= 0) {
          r = 255; g = 255; b = 255;
        }
      }
      
      pixelData[idx] = r;
      pixelData[idx + 1] = g;
      pixelData[idx + 2] = b;
      pixelData[idx + 3] = 255; // Full alpha
    }
  }
  
  return createPNG(size, size, pixelData);
}

function createPNG(width, height, pixelData) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8);   // bit depth
  ihdrData.writeUInt8(6, 9);   // color type: RGBA
  ihdrData.writeUInt8(0, 10);  // compression
  ihdrData.writeUInt8(0, 11);  // filter
  ihdrData.writeUInt8(0, 12);  // interlace
  
  // Prepare raw image data with filter bytes
  const rawData = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    rawData[y * (width * 4 + 1)] = 0; // filter byte
    pixelData.copy(rawData, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  
  const zlib = require('zlib');
  const compressedData = zlib.deflateSync(rawData);
  
  return Buffer.concat([
    signature,
    createChunk('IHDR', ihdrData),
    createChunk('IDAT', compressedData),
    createChunk('IEND', Buffer.alloc(0))
  ]);
}

function createChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  
  const chunkData = Buffer.concat([length, typeBuffer, data]);
  const crc = calculateCRC(Buffer.concat([typeBuffer, data]));
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);
  
  return Buffer.concat([chunkData, crcBuffer]);
}

function calculateCRC(data) {
  let crc = 0xFFFFFFFF;
  const table = getCRC32Table();
  
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function getCRC32Table() {
  const table = [];
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = 0xEDB88320 ^ (crc >>> 1);
      } else {
        crc = crc >>> 1;
      }
    }
    table[i] = crc >>> 0;
  }
  return table;
}

console.log('Generating icons...');
