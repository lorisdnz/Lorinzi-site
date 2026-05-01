import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const report = {};

  const supabase = createClient(
    process.env.PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // 1. Dernière commande — est-ce que les imageUrls sont bien dans la DB ?
  try {
    const { data: orders } = await supabase
      .from('orders')
      .select('id, status, created_at, story')
      .order('created_at', { ascending: false })
      .limit(1);

    const order = orders?.[0];
    if (order) {
      const pages = order.story?.pages || [];
      const pagesWithImages    = pages.filter(p => p.imageUrl).length;
      const pagesWithoutImages = pages.filter(p => !p.imageUrl).length;

      report.last_order = {
        id:                   order.id.slice(0, 8),
        status:               order.status,
        date:                 order.created_at,
        total_pages:          pages.length,
        pages_with_imageUrl:  pagesWithImages,
        pages_without_imageUrl: pagesWithoutImages,
        sample_imageUrl:      pages.find(p => p.imageUrl)?.imageUrl || 'AUCUNE',
      };

      // 2. Tester si on peut télécharger l'image via Supabase admin
      const sampleUrl = pages.find(p => p.imageUrl)?.imageUrl;
      if (sampleUrl) {
        try {
          const match = sampleUrl.match(/\/storage\/v1\/object\/(?:public\/)?images\/(.+?)(?:\?|$)/);
          if (match?.[1]) {
            const { data, error } = await supabase.storage.from('images').download(match[1]);
            report.image_download_test = {
              filename: match[1],
              ok:       !!data && !error,
              error:    error?.message || null,
              size_kb:  data ? Math.round((await data.arrayBuffer()).byteLength / 1024) : null,
            };
          } else {
            report.image_download_test = { ok: false, error: 'URL pattern ne correspond pas', url: sampleUrl };
          }
        } catch (e) {
          report.image_download_test = { ok: false, error: e.message };
        }
      } else {
        report.image_download_test = { ok: false, error: 'Aucune imageUrl dans la commande — images jamais sauvegardées' };
      }
    }
  } catch (e) {
    report.last_order = { error: e.message };
  }

  // 3. Dernières images dans le bucket
  try {
    const { data: files } = await supabase.storage
      .from('images')
      .list('', { limit: 5, sortBy: { column: 'created_at', order: 'desc' } });
    report.bucket_images = files?.map(f => ({ name: f.name, size_kb: Math.round(f.metadata?.size / 1024) })) || [];
  } catch (e) {
    report.bucket_images = { error: e.message };
  }

  // 4. Leonardo — tokens restants
  try {
    const r = await fetch('https://cloud.leonardo.ai/api/rest/v1/me', {
      headers: { 'Authorization': `Bearer ${process.env.LEONARDO_API_KEY}` },
    });
    const data = await r.json();
    report.leonardo = {
      ok:     r.ok,
      tokens: data?.user_details?.[0]?.subscriptionTokens,
      user:   data?.user_details?.[0]?.user?.username,
    };
  } catch (e) {
    report.leonardo = { ok: false, error: e.message };
  }

  return res.status(200).json(report, null, 2);
}
