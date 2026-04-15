#!/bin/bash

FAL_KEY="${FAL_KEY}"
PROMPTS=(
  "Watercolor children's book illustration, a brave young boy with curly red hair holding a glowing lantern exploring an enchanted forest, magical fireflies, warm golden lighting, storybook style, high quality"
  "Watercolor children's book illustration, a little girl with braids riding a friendly dragon over colorful clouds and rainbow mountains, magical adventure, soft pastel colors, professional children's book art"
  "Watercolor children's book illustration, a young child in an astronaut suit floating in a whimsical space with friendly planets, stars, and a smiling moon, pastel colors, storybook style"
)

for i in ${!PROMPTS[@]}; do
  INDEX=$((i + 1))
  PROMPT="${PROMPTS[$i]}"
  
  echo "Generating image $INDEX/3..."
  
  RESPONSE=$(curl -s -X POST "https://fal.run/fal-ai/flux/schnell" \
    -H "Authorization: Key $FAL_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"prompt\": \"$PROMPT\", \"num_inference_steps\": 20, \"guidance_scale\": 7.5, \"image_size\": \"square\"}")
  
  IMAGE_URL=$(echo "$RESPONSE" | grep -o '"url":"[^"]*' | head -1 | cut -d'"' -f4)
  
  if [ -n "$IMAGE_URL" ]; then
    curl -s -o "public/sample$INDEX.png" "$IMAGE_URL"
    echo "✓ Saved sample$INDEX.png"
  else
    echo "✗ Failed to generate image $INDEX"
    echo "Response: $RESPONSE"
  fi
  
  sleep 2
done

echo "Image generation complete"
