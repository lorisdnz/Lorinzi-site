import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const LEONARDO_API = 'https://cloud.leonardo.ai/api/rest/v1';
// Leonardo Kino XL — meilleur rendu pour illustrations riches et détaillées
const MODEL_ID     = 'aa77f04e-3eec-4034-9c07-d0836021196f';

async function generateWithLeonardo(apiKey, prompt) {
  const genRes = await fetch(`${LEONARDO_API}/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      prompt,
      modelId:     MODEL_ID,
      width:       1024,
      height:      1024,
      num_images:  1,
      presetStyle: 'DYNAMIC',
      alchemy:     true,
      photoReal:   false,
      highContrast: true,
    }),
  });

  const genData      = await genRes.json();
  const generationId = genData.sdGenerationJob?.generationId;
  if (!generationId) throw new Error('Leonardo: no generationId — ' + JSON.stringify(genData));

  // Poll toutes les 2s — max 25 fois = 50 secondes
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const poll    = await fetch(`${LEONARDO_API}/generations/${generationId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data    = await poll.json();
    const gen     = data.generations_by_pk;
    if (gen?.status === 'COMPLETE') {
      const url = gen.generated_images?.[0]?.url;
      if (!url) throw new Error('Leonardo: no image URL');
      return url;
    }
    if (gen?.status === 'FAILED') throw new Error('Leonardo: generation failed');
  }
  throw new Error('Leonardo: timeout');
}

async function uploadToSupabase(supabase, imageUrl, filename) {
  const res    = await fetch(imageUrl);
  const buffer = await res.arrayBuffer();
  const { error } = await supabase.storage
    .from('images')
    .upload(filename, Buffer.from(buffer), { contentType: 'image/png' });
  if (error) throw new Error(error.message);
  const { data: { publicUrl } } = supabase.storage.from('images').getPublicUrl(filename);
  return publicUrl;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { story, age, gender, childDescription } = req.body;
    if (!story?.pages?.length) return res.status(400).json({ error: 'Histoire manquante' });

    const openai      = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const leonardoKey = process.env.LEONARDO_API_KEY;
    const supabase    = createClient(
      process.env.PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const genderStr = gender === 'fille' ? 'girl' : gender === 'garcon' ? 'boy' : 'child';

    // GPT génère une description UNIQUE et très précise du personnage
    const charRes = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.1,
      max_tokens: 60,
      messages: [{
        role: 'user',
        content:
          `Write a SHORT precise character description for a children's book illustration. ` +
          `Character: ${age || 5}-year-old ${genderStr}. ` +
          (childDescription ? `Traits: ${childDescription}. ` : '') +
          `Include: hair color+style, eye color, skin tone, specific outfit (shirt, pants, shoes). ` +
          `Max 35 words. English only. Be very specific about colors.`,
      }],
    });

    const characterDesc = charRes.choices[0].message.content.trim();
    console.log('[images] Character:', characterDesc);

    // Style identique verrouillé pour TOUTES les images
    const STYLE =
      'high quality children\'s book illustration, rich vibrant saturated colors, ' +
      'detailed digital painting, expressive cartoon characters with big round eyes, ' +
      'warm cheerful lighting, soft shading and depth, professional storybook quality, ' +
      'colorful and joyful atmosphere, consistent character design throughout';

    // Toutes les images en PARALLÈLE — fiable et rapide
    const results = await Promise.all(
      story.pages.map(async (page) => {
        const prompt =
          `${STYLE}. ` +
          `Main character always identical: ${characterDesc}. ` +
          `Same face, same hair, same outfit as all other pages. ` +
          `Scene: ${page.imagePrompt}. ` +
          `No text, no letters, no words anywhere in the image.`;

        try {
          const rawUrl    = await generateWithLeonardo(leonardoKey, prompt);
          const filename  = `p${page.pageNumber}-${Date.now()}.png`;
          const publicUrl = await uploadToSupabase(supabase, rawUrl, filename);
          console.log(`[images] Page ${page.pageNumber} ✓`);
          return { pageNumber: page.pageNumber, imageUrl: publicUrl };
        } catch (err) {
          console.error(`[images] Page ${page.pageNumber} ✗:`, err.message);
          return { pageNumber: page.pageNumber, imageUrl: null };
        }
      })
    );

    const ok = results.filter(r => r.imageUrl).length;
    console.log(`[images] ${ok}/${story.pages.length} generated`);

    return res.status(200).json({
      ...story,
      pages: story.pages.map(page => {
        const r = results.find(x => x.pageNumber === page.pageNumber);
        return { ...page, imageUrl: r?.imageUrl || null };
      }),
    });

  } catch (err) {
    console.error('[images]', err);
    return res.status(500).json({ error: err.message });
  }
}
