import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAL_API_KEY = process.env.FAL_KEY || '';

const prompts = [
  "Watercolor children's book illustration, a brave young boy with curly red hair holding a glowing lantern exploring an enchanted forest, magical fireflies, warm golden lighting, storybook style, high quality",
  "Watercolor children's book illustration, a little girl with braids riding a friendly dragon over colorful clouds and rainbow mountains, magical adventure, soft pastel colors, professional children's book art",
  "Watercolor children's book illustration, a young child in an astronaut suit floating in a whimsical space with friendly planets, stars, and a smiling moon, pastel colors, storybook style",
];

async function generateImage(prompt, index) {
  try {
    console.log(`Generating image ${index + 1}/3: ${prompt.substring(0, 50)}...`);
    
    const response = await fetch('https://fal.run/fal-ai/flux/schnell', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        num_inference_steps: 20,
        guidance_scale: 7.5,
        image_size: 'square',
      }),
    });

    const data = await response.json();
    if (data.images && data.images[0]) {
      const imageUrl = data.images[0].url;
      const outputPath = path.join(__dirname, '..', 'public', `sample${index + 1}.png`);
      
      const imageResponse = await fetch(imageUrl);
      const buffer = await imageResponse.buffer();
      fs.writeFileSync(outputPath, buffer);
      console.log(`✓ Saved to ${outputPath}`);
      return true;
    } else {
      console.error(`Failed to generate image ${index + 1}:`, data);
      return false;
    }
  } catch (error) {
    console.error(`Error generating image ${index + 1}:`, error);
    return false;
  }
}

async function main() {
  if (!FAL_API_KEY) {
    console.error('FAL_KEY environment variable not set');
    process.exit(1);
  }
  console.log('Starting image generation...');
  for (let i = 0; i < prompts.length; i++) {
    await generateImage(prompts[i], i);
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('Image generation complete');
}

main();
