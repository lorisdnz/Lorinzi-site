import OpenAI from 'openai';

function buildPrompt(data) {
  const pageCount = data.bookFormat === 'court' ? 6 : data.bookFormat === 'classique' ? 10 : 15;
  const styleMap = {
    magique: 'magique et féerique, plein de créatures enchanteresses',
    aventure: "d'aventure et d'exploration avec des défis à surmonter",
    quotidien: 'tendre et ancré dans le quotidien',
    educatif: 'éducatif et bienveillant',
    surprise: 'surprenant et original',
  };

  const childAppearance = [data.skinColor, data.eyeColor, data.hairColor].filter(Boolean).join(', ');
  const petAppearance = data.petColor ? `couleur : ${data.petColor}` : '';
  const personAppearance = [data.personSkinColor, data.personEyeColor, data.personHairColor].filter(Boolean).join(', ');

  return `Tu es un auteur de livres pour enfants. Crée une histoire personnalisée en français.

INFORMATIONS SUR L'ENFANT :
- Prénom : ${data.childFirstName}${data.nickname ? ` (surnom : "${data.nickname}")` : ''}
- Genre : ${data.gender}
- Âge : ${data.age} ans
- Caractère : ${data.personality}${childAppearance ? `\n- Apparence : ${childAppearance}` : ''}
- Ce qu'il/elle aime : ${(data.hobbies || []).join(', ')}${data.hobbiesOther ? `, ${data.hobbiesOther}` : ''}
${data.hasPet && data.petName ? `- Animal de compagnie : ${data.petName} (${data.petSpecies}${petAppearance ? ', ' + petAppearance : ''})` : ''}
${data.importantPeople ? `- Personnages à inclure : ${data.importantPeople}${personAppearance ? ` (apparence : ${personAppearance})` : ''}` : ''}
- Lieu de l'histoire : ${data.storySetting}

IMPORTANT POUR LES ILLUSTRATIONS : Dans chaque imagePrompt, décris toujours le personnage principal avec ces caractéristiques précises :${childAppearance ? ` ${childAppearance}` : ''} pour que les illustrations soient cohérentes d'une page à l'autre.

STYLE : Histoire de type ${styleMap[data.storyStyle] || 'magique'}.
${data.includeEducationalMessage && data.educationalTheme ? `MESSAGE ÉDUCATIF : Intègre subtilement : ${data.educationalTheme}.` : ''}

FORMAT :
- Exactement ${pageCount} pages.
- 80 à 120 mots par page, adaptés à ${data.age} ans.
- Retourne uniquement du JSON valide :

{
  "title": "Titre de l'histoire",
  "pages": [
    {
      "pageNumber": 1,
      "text": "Texte de la page...",
      "imagePrompt": "Description en anglais de l'illustration (style children's book, colorful, warm)"
    }
  ]
}`.trim();
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = req.body;

    if (!data.childFirstName || !data.gender || !data.age || !data.storyStyle) {
      return res.status(400).json({ error: 'Données du formulaire incomplètes' });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: buildPrompt(data) }],
      response_format: { type: 'json_object' },
      temperature: 0.85,
    });

    const story = JSON.parse(completion.choices[0].message.content);
    return res.status(200).json(story);
  } catch (err) {
    console.error('[generate-story]', err);
    return res.status(500).json({ error: err.message });
  }
}
