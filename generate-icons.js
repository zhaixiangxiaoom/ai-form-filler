#!/usr/bin/env node

// Simple script to generate placeholder PNG icons
// This creates basic colored squares as placeholder icons

const fs = require('fs');
const path = require('path');

// Minimal valid PNG files (1x1 pixel, will be scaled by Chrome)
// These are base64 encoded minimal PNG files

const iconSizes = [16, 48, 128];

iconSizes.forEach(size => {
  const fileName = `icon${size}.png`;
  const filePath = path.join(__dirname, fileName);
  
  // Create a simple 1x1 PNG and Chrome will scale it
  // This is a minimal valid PNG file
  const pngBuffer = createMinimalPNG();
  
  fs.writeFileSync(filePath, pngBuffer);
  console.log(`Created ${fileName}`);
});

function createMinimalPNG() {
  // This creates a minimal valid PNG file
  // PNG signature + IHDR chunk + IDAT chunk + IEND chunk
  
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR chunk (image header)
  const width = 1;
  const height = 1;
  const bitDepth = 8;
  const colorType = 2; // RGB
  const compression = 0;
  const filter = 0;
  const interlace = 0;
  
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(bitDepth, 8);
  ihdrData.writeUInt8(colorType, 9);
  ihdrData.writeUInt8(compression, 10);
  ihdrData.writeUInt8(filter, 11);
  ihdrData.writeUInt8(interlace, 12);
  
  const ihdrChunk = createChunk('IHDR', ihdrData);
  
  // IDAT chunk (image data) - single blue pixel
  const rawData = Buffer.from([0, 0, 128, 255]); // filter byte + RGB
  const compressedData = deflateRaw(rawData);
  const idatChunk = createChunk('IDAT', compressedData);
  
  // IEND chunk (end)
  const iendChunk = createChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
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
  // Simplified CRC32 - for production use a proper CRC32 library
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
    crc = crc >>> 0;
    table[i] = crc;
  }
  return table;
}

function deflateRaw(data) {
  // Minimal deflate implementation
  // For production, use the 'zlib' module
  const zlib = require('zlib');
  return zlib.deflateRawSync(data);
}

console.log('Generating placeholder icons...');
