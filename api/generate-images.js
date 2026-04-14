import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { story, age, gender, childDescription } = req.body;

    if (!story?.pages?.length) {
      return res.status(400).json({ error: 'Données histoire manquantes' });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const supabase = createClient(
      process.env.PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const genderStr = gender === 'fille' ? 'girl' : gender === 'garcon' ? 'boy' : 'child';
    const ageStr = age || 5;

    // Step 1: Ask GPT to define a precise visual character description once
    const charPrompt = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: `Define a precise, detailed visual description of a ${ageStr}-year-old ${genderStr} character for a children's book illustration series.
${childDescription ? `Physical traits: ${childDescription}.` : ''}
Give ONLY a single short paragraph in English describing: face shape, hair (color, style, length), eyes, skin tone, and ONE specific outfit (colors, clothing items, shoes).
This description will be copy-pasted identically into every image prompt to keep the character consistent. Be very specific and concise (max 60 words).`
      }],
      temperature: 0.3,
      max_tokens: 120,
    });

    const characterDesc = charPrompt.choices[0].message.content.trim();
    console.log('[generate-images] Character description:', characterDesc);

    // Step 2: Build the consistent style prefix using the defined character
    const stylePrefix =
      `Children's book illustration. Art style: colorful cartoon, thick clean outlines, smooth flat colors, cute rounded shapes, professional storybook quality. ` +
      `NO watercolor, NO realistic, NO sketch, NO painterly texture — always clean cartoon style. ` +
      `Main character (IDENTICAL in every single image — same face shape, same hair, same clothes, never change anything): ${characterDesc} ` +
      `Scene: `;

    // Step 3: Helper to upload image
    async function generateAndUpload(pageNumber, prompt) {
      const image = await openai.images.generate({
        model: 'dall-e-3',
        prompt: `${prompt} No text, no letters, no words anywhere in the image.`,
        size: '1024x1024',
        quality: 'hd',
        n: 1,
      });

      const tempUrl = image.data[0].url;
      const imgRes = await fetch(tempUrl);
      const imgBuffer = await imgRes.arrayBuffer();

      const filename = `page-${Date.now()}-${pageNumber}.png`;
      const { error: uploadErr } = await supabase.storage
        .from('images')
        .upload(filename, Buffer.from(imgBuffer), { contentType: 'image/png' });

      if (uploadErr) throw new Error(uploadErr.message);

      const { data: { publicUrl } } = supabase.storage
        .from('images')
        .getPublicUrl(filename);

      return publicUrl;
    }

    // Step 4: Generate all images in parallel with the consistent character
    const results = await Promise.all(
      story.pages.map(async (page) => {
        const prompt = `${stylePrefix}${page.imagePrompt}`;
        try {
          const imageUrl = await generateAndUpload(page.pageNumber, prompt);
          return { pageNumber: page.pageNumber, imageUrl };
        } catch (err) {
          console.error(`Image failed for page ${page.pageNumber}:`, err.message);
          return { pageNumber: page.pageNumber, imageUrl: null };
        }
      })
    );

    const storyWithImages = {
      ...story,
      pages: story.pages.map((page) => {
        const r = results.find((x) => x.pageNumber === page.pageNumber);
        return { ...page, imageUrl: r?.imageUrl || null };
      }),
    };

    return res.status(200).json(storyWithImages);
  } catch (err) {
    console.error('[generate-images]', err);
    return res.status(500).json({ error: err.message });
  }
}
