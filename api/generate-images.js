import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const LEONARDO_API = 'https://cloud.leonardo.ai/api/rest/v1';
const MODEL_ID     = '6b645e3a-d64f-4341-a6d8-7a3690fbf042'; // Anime XL — vérifié fonctionnel

const ART_STYLE =
  'beautiful children\'s book illustration, warm rich colors, ' +
  'detailed digital painting, soft rounded shapes, expressive characters with big eyes, ' +
  'warm golden lighting, gentle shading, professional storybook quality, ' +
  'consistent character design throughout the book';

// ── PHASE 1 : Soumettre toutes les générations Leonardo en parallèle (~2s) ──
async function submitGenerations(apiKey, prompts) {
  return Promise.all(prompts.map(async ({ pageNumber, prompt }) => {
    const res = await fetch(`${LEONARDO_API}/generations`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        modelId:         MODEL_ID,
        width:           1024,
        height:          1024,
        num_images:      1,
        presetStyle:     'ILLUSTRATION',
        alchemy:         true,
        photoReal:       false,
        negative_prompt: 'text, words, letters, watermark, blurry, deformed, ugly, multiple characters, different outfit',
      }),
    });
    const data        = await res.json();
    const generationId = data.sdGenerationJob?.generationId;
    if (!generationId) {
      console.error(`[images] Submit failed p${pageNumber}:`, JSON.stringify(data));
      return { pageNumber, generationId: null };
    }
    console.log(`[images] Submitted p${pageNumber} → ${generationId}`);
    return { pageNumber, generationId };
  }));
}

// ── PHASE 2 : Vérifier le statut d'une génération ──
async function checkGeneration(apiKey, generationId) {
  const res  = await fetch(`${LEONARDO_API}/generations/${generationId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  const data = await res.json();
  const gen  = data.generations_by_pk;
  return {
    status: gen?.status || 'PENDING',
    url:    gen?.generated_images?.[0]?.url || null,
  };
}

async function uploadToSupabase(supabase, imageUrl, filename) {
  const res    = await fetch(imageUrl);
  const buffer = await res.arrayBuffer();
  const { error } = await supabase.storage
    .from('images')
    .upload(filename, Buffer.from(buffer), { contentType: 'image/png', upsert: true });
  if (error) throw new Error('Supabase upload: ' + error.message);
  const { data: { publicUrl } } = supabase.storage.from('images').getPublicUrl(filename);
  return publicUrl;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { story, age, gender, childDescription, generationIds } = req.body;
    if (!story?.pages?.length) return res.status(400).json({ error: 'Histoire manquante' });

    const leonardoKey = process.env.LEONARDO_API_KEY;
    const supabase    = createClient(
      process.env.PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ── MODE POLL : Le client renvoie les generationIds pour récupérer les résultats ──
    if (generationIds && Array.isArray(generationIds)) {
      const results = await Promise.all(
        generationIds.map(async ({ pageNumber, generationId }) => {
          if (!generationId) return { pageNumber, imageUrl: null, status: 'FAILED' };
          try {
            const { status, url } = await checkGeneration(leonardoKey, generationId);
            if (status === 'COMPLETE' && url) {
              const filename  = `p${pageNumber}-${Date.now()}.png`;
              const publicUrl = await uploadToSupabase(supabase, url, filename);
              return { pageNumber, imageUrl: publicUrl, status: 'DONE', generationId };
            }
            return { pageNumber, imageUrl: null, status, generationId };
          } catch (err) {
            console.error(`[images] Poll p${pageNumber}:`, err.message);
            return { pageNumber, imageUrl: null, status: 'FAILED', generationId };
          }
        })
      );

      const done    = results.filter(r => r.status === 'DONE').length;
      const failed  = results.filter(r => r.status === 'FAILED').length;
      const pending = results.filter(r => r.status !== 'DONE' && r.status !== 'FAILED').length;
      console.log(`[images] Poll: done=${done} pending=${pending} failed=${failed}`);

      return res.status(200).json({ results, done, pending, failed });
    }

    // ── MODE SUBMIT : Soumettre toutes les générations, retourner les IDs immédiatement ──
    const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const genderStr = gender === 'fille' ? 'girl' : gender === 'garcon' ? 'boy' : 'child';

    // Description du personnage verrouillée
    const charRes = await openai.chat.completions.create({
      model: 'gpt-4o', temperature: 0, max_tokens: 80,
      messages: [{
        role: 'user',
        content:
          `Create a precise visual description for a children's book character. ` +
          `${age || 5}-year-old ${genderStr}. ` +
          (childDescription ? `Traits: ${childDescription}. ` : '') +
          `Specify: hair color/style, eye color, skin tone, ONE outfit (colors of shirt, pants, shoes) that NEVER changes. ` +
          `Max 50 words. English only.`,
      }],
    });
    const characterDesc = charRes.choices[0].message.content.trim();
    console.log('[images] Character:', characterDesc);

    // Construire tous les prompts
    const prompts = story.pages.map(page => ({
      pageNumber: page.pageNumber,
      prompt: [
        `${ART_STYLE}.`,
        `MAIN CHARACTER (identical in every image): ${characterDesc}.`,
        `SCENE: ${page.imagePrompt}.`,
        `No text, no letters, no words in the image.`,
      ].join(' '),
    }));

    // Soumettre toutes les générations (~2-5s)
    const submissions = await submitGenerations(leonardoKey, prompts);
    const submitted   = submissions.filter(s => s.generationId).length;
    console.log(`[images] Submitted ${submitted}/${story.pages.length} generations`);

    // Retourner les IDs immédiatement — le client va poller
    return res.status(200).json({
      characterDesc,
      generationIds: submissions,
      total:         story.pages.length,
      submitted,
    });

  } catch (err) {
    console.error('[images]', err);
    return res.status(500).json({ error: err.message });
  }
}
