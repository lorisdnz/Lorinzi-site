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

    // Build consistent character + style prefix for ALL images
    const genderStr = gender === 'fille' ? 'girl' : gender === 'garcon' ? 'boy' : 'child';
    const characterBase = `a ${age || 5}-year-old ${genderStr}${childDescription ? ` with ${childDescription}` : ''}`;
    const stylePrefix =
      `Flat design children's book illustration. Simple bold shapes, clean thick outlines, bright flat solid colors. ` +
      `Consistent cartoon style throughout. Same character in every image: ${characterBase}, ` +
      `cute round face, simple friendly expression, EXACT SAME outfit and appearance as all other pages. `;

    // Generate all images in parallel
    const results = await Promise.all(
      story.pages.map(async (page) => {
        const prompt = `${stylePrefix}Scene: ${page.imagePrompt}. No text, no letters, no words in the image.`;
        try {
          const image = await openai.images.generate({
            model: 'dall-e-3',
            prompt,
            size: '1024x1024',
            quality: 'standard',
            n: 1,
          });

          const tempUrl = image.data[0].url;

          // Download image from DALL-E (temporary URL)
          const imgRes = await fetch(tempUrl);
          const imgBuffer = await imgRes.arrayBuffer();

          // Upload to Supabase Storage (permanent URL)
          const filename = `page-${Date.now()}-${page.pageNumber}.png`;
          const { error: uploadErr } = await supabase.storage
            .from('images')
            .upload(filename, Buffer.from(imgBuffer), { contentType: 'image/png' });

          if (uploadErr) throw new Error(uploadErr.message);

          const { data: { publicUrl } } = supabase.storage
            .from('images')
            .getPublicUrl(filename);

          return { pageNumber: page.pageNumber, imageUrl: publicUrl };
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
