#!/usr/bin/env node
const fs = require('fs');
const fetch = require('node-fetch');

(async () => {
  try {
    const response = await fetch('https://api.fal.ai/generate/images', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: 'Whimsical watercolor storybook illustration of diverse characters in a magical forest',
        num_images: 4,
        size: '1024x1024'
      })
    });
    const data = await response.json();
    if (!data.images || !Array.isArray(data.images)) {
      throw new Error('Invalid response: ' + JSON.stringify(data));
    }
    for (let i = 0; i < data.images.length; i++) {
      const imgUrl = data.images[i];
      const imgRes = await fetch(imgUrl);
      const buffer = await imgRes.buffer();
      const outPath = `public/sample${i+1}.png`;
      fs.writeFileSync(outPath, buffer);
      console.log(`Wrote ${outPath}`);
    }
  } catch (err) {
    console.error('Error generating images:', err);
    process.exit(1);
  }
})();
