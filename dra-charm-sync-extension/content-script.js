/**
 * Dra Charm Sync — Content Script
 * Roda automaticamente em qualquer página do painel LI de pedidos.
 * Se a URL tem #drachrm-autosync na hash, dispara o sync sozinho.
 * Também emite um "ready" pro window.opener assim que carrega — o app usa isso
 * pra saber que a extensão está instalada.
 */
(function(){
  const APP_ORIGINS = [
    'https://producao-dra-charm.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ];
  const SKU_LOGOMARCA = 'U4UDXDTVP';
  const SKU_PERSONALIZACAO = 'QGH2F6NFR';

  // Notifica o window opener (app Dra Charm) que a extensão está viva
  function pingOpener(){
    if (!window.opener) return;
    for (const origin of APP_ORIGINS){
      try { window.opener.postMessage({type:'draCharmSyncExtensionReady', version:'1.0.0'}, origin); } catch(e){}
    }
  }
  pingOpener();

  // Só roda o sync se a URL tem o marcador (query param OR hash)
  const url = new URL(window.location.href);
  const hasQueryMarker = url.searchParams.has('dc_sync');
  const hasHashMarker = (window.location.hash||'').includes('drachrm-autosync');
  if (!hasQueryMarker && !hasHashMarker) return;

  // Espera a página estabilizar mais um cadinho
  setTimeout(run, 1200);

  async function run(){
    const APP_ORIGIN = APP_ORIGINS[0];

    // UI de progresso
    const oldPanel = document.getElementById('drachrm-sync-panel');
    if (oldPanel) oldPanel.remove();
    const panel = document.createElement('div');
    panel.id = 'drachrm-sync-panel';
    panel.style.cssText = 'position:fixed;top:20px;right:20px;background:#fff;border:3px solid #f59e0b;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.2);padding:16px 20px;z-index:2147483647;font-family:sans-serif;font-size:14px;min-width:280px;max-width:380px;color:#000';
    panel.innerHTML = '<div style="font-weight:bold;color:#f59e0b;margin-bottom:8px">🧵 Sync Dra Charm</div><div id="drachrm-sync-status">Iniciando...</div><div id="drachrm-sync-progress" style="margin-top:8px;height:6px;background:#eee;border-radius:3px;overflow:hidden"><div id="drachrm-sync-bar" style="width:0%;height:100%;background:#f59e0b;transition:width .2s"></div></div>';
    document.body.appendChild(panel);
    const setStatus = (t) => { document.getElementById('drachrm-sync-status').textContent = t; };
    const setProgress = (pct) => { document.getElementById('drachrm-sync-bar').style.width = pct + '%'; };

    // Coleta IDs (todas as páginas)
    function collectIdsFromDoc(doc){
      return [...new Set(
        Array.from(doc.querySelectorAll('a[href*="/painel/pedido/"]'))
          .map(a => a.href.match(/pedido\/(\d+)/)?.[1])
          .filter(Boolean)
      )];
    }
    const currentUrl = new URL(window.location.href);
    const dateStart = currentUrl.searchParams.get('data_inicio');
    const dateEnd = currentUrl.searchParams.get('data_fim');
    if (!dateStart){
      setStatus('❌ URL sem filtro de data (esperava data_inicio). Abre pelo botão do app.');
      return;
    }
    const totalMatch = document.body.innerText.match(/Mostrando\s+\d+\s+de\s+(\d+)/i);
    const totalCount = totalMatch ? parseInt(totalMatch[1]) : 50;
    const pageSize = 50;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    setStatus(`Total ${totalCount} pedidos em ${totalPages} página(s). Coletando IDs...`);

    const allIds = collectIdsFromDoc(document);
    for (let p = 2; p <= totalPages; p++){
      setStatus(`Coletando IDs da página ${p}/${totalPages}...`);
      setProgress(Math.round((p/totalPages)*30));
      try {
        // LI usa PATH pra paginar: /painel/pedido/listar/pagina/N
        const pageUrl = `${currentUrl.origin}/painel/pedido/listar/pagina/${p}?data_inicio=${encodeURIComponent(dateStart)}&data_fim=${encodeURIComponent(dateEnd)}`;
        const html = await fetch(pageUrl, {credentials:'include'}).then(r => r.text());
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const ids = collectIdsFromDoc(doc);
        for (const id of ids) if (!allIds.includes(id)) allIds.push(id);
      } catch(e){}
    }
    const orderIds = allIds;
    if (orderIds.length === 0){
      setStatus('❌ Nenhum pedido encontrado nesta data.');
      setTimeout(() => panel.remove(), 5000);
      return;
    }
    setStatus(`Encontrei ${orderIds.length} pedidos. Analisando um a um...`);

    // Parse detail de cada pedido
    function parseOrderDetail(html, orderId){
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const txt = doc.body.innerText;
      const skus = [...txt.matchAll(/SKU:\s*([^\n]+)/g)].map(m=>m[1].trim());
      const hasLogo = skus.includes(SKU_LOGOMARCA);
      const hasPerso = skus.includes(SKU_PERSONALIZACAO);
      if (!hasLogo && !hasPerso) return null;

      // Filtro de status: pula pedidos cancelados/aguardando/disputa/etc
      const situacoes = [...txt.matchAll(/Situação:\s*([^\n]+)/g)].map(m => m[1].trim());
      const ultimaSituacao = situacoes[situacoes.length-1] || '';
      const statusInvalido = /cancelad|devolvid|chargeback|disputa|análise|analise|aguardando pgto|solicitad/i;
      if (statusInvalido.test(ultimaSituacao)) return null;

      // Cliente: pega do histórico (aceita minúsculo) OU do endereço de entrega
      let cliente = '';
      const cliMatch = txt.match(/Pedido Efetuado\s*\t?\s*([^\n\t]+?)\s*\(cliente\)/i);
      if (cliMatch) cliente = cliMatch[1].trim();
      if (!cliente){
        const cliMatch2 = txt.match(/([\S ]+?)\s*\(cliente\)/);
        if (cliMatch2) cliente = cliMatch2[1].trim();
      }
      if (!cliente){
        // Fallback: pega do endereço de entrega (linha após "Endereço de entrega")
        const endMatch = txt.match(/Endereço de entrega[^\n]*\n\s*([^\n]+)/);
        if (endMatch) cliente = endMatch[1].trim();
      }
      // Capitaliza nomes minúsculos
      cliente = cliente.split(/\s+/).map(w => w.length>2 ? w.charAt(0).toUpperCase()+w.slice(1).toLowerCase() : w).join(' ');

      const personaMatch = txt.match(/Personalização de produtos:?([\s\S]{0,5000}?)(?=Pagamento via|Detalhes do cliente|Endereço de entrega|ID\s+da transação|$)/);
      const persoBlock = personaMatch ? personaMatch[1] : '';
      const fields = {};
      // Regex robusto: para em próximo campo, separadores, ou fim (funciona com ou sem \n)
      for (const m of persoBlock.matchAll(/--\s+([A-ZÀ-Ýa-zà-ÿ][^:]*?):\s*(.*?)(?=--\s+[A-ZÀ-Ýa-zà-ÿ]|-{3,}|\*\*|={3,}|Mensagem\s+cartão|Pagamento\s+via|$)/gs)){
        const k = m[1].trim().toLowerCase().replace(/\.$/,''), v = m[2].trim().replace(/\s+/g,' ');
        if (k && !fields[k]) fields[k] = v;
      }
      // Extrai mensagem do cartão se existir (fica em bordado_detalhes se não já tem)
      // Mensagem do cartão é presente/embalagem — NÃO é instrução de bordado

      // Parse produtos com fotos — parser DOM (funciona em página fetched sem layout)
      const produtos = [];
      const skusSkip = ['U4UDXDTVP', 'QGH2F6NFR', 'embalagem-de-presente_hidden'];
      const prodLinks = Array.from(doc.querySelectorAll('a[href*="/painel/catalogo/produto/"]'))
        .filter(a => /\/produto\/\d+\/editar/.test(a.href) && a.textContent.trim().length > 3);
      for (const link of prodLinks){
        const nome = link.textContent.trim();
        if (/Acréscimo|Embalagem/i.test(nome)) continue;
        const infoBox = link.parentElement;
        const row = infoBox?.parentElement;
        const boxTxt = infoBox?.textContent || '';
        const skuM = boxTxt.match(/SKU:\s*([^\s\n]+)/);
        const sku = skuM ? skuM[1].trim() : '';
        if (!sku || skusSkip.includes(sku)) continue;
        const tamM = boxTxt.match(/TAMANHO\s*:\s*([^\s\n]+)/);
        const qtyM = (row?.textContent || '').match(/Qtd:\s*(\d+)/);
        const img = row?.querySelector('img');
        produtos.push({
          nome, sku,
          tamanho: tamM ? tamM[1].trim() : '',
          qtd: qtyM ? parseInt(qtyM[1]) : 1,
          imagem_url: img?.src || null,
        });
      }
      let corHex = null, corNome = null;
      if (fields['cores']){
        const cm = fields['cores'].match(/^(#[0-9a-fA-F]{3,8})-(.+)$/);
        if (cm){ corHex = cm[1]; corNome = cm[2].trim(); }
        else { corNome = fields['cores']; }
      }
      let imgUrl = null;
      if (fields['fazer upload da imagem']) imgUrl = fields['fazer upload da imagem'];
      else {
        const imgM = persoBlock.match(/https?:\/\/[^\s\n]+\.(?:jpg|jpeg|png|pdf|svg|gif)/i);
        if (imgM) imgUrl = imgM[0];
      }
      let tipo = null;
      if (hasLogo && hasPerso) tipo = 'ambos';
      else if (hasLogo) tipo = 'logomarca';
      else if (hasPerso) tipo = 'nome_profissao';

      return {
        pedido_numero: orderId,
        pedido_cliente: cliente,
        pedido_url: `https://app.lojaintegrada.com.br/painel/pedido/${orderId}/detalhar`,
        bordado_tipo: tipo,
        bordado_linha1: fields['linha 1*'] || fields['linha 1'] || null,
        bordado_linha2: fields['linha 2*'] || fields['linha 2'] || null,
        bordado_cor_hex: corHex,
        bordado_cor_nome: corNome,
        bordado_fonte: fields['tipo de letra'] || null,
        bordado_lado: fields['lados'] || fields['lado'] || null,
        bordado_imagem_url: imgUrl,
        bordado_detalhes: fields['detalhes do bordado (opcional)'] || fields['detalhes do bordado'] || null,
        pedido_produtos: produtos.length ? produtos : null,
      };
    }

    const results = [];
    let done = 0;
    const CONCURRENCY = 4;
    for (let i=0; i<orderIds.length; i += CONCURRENCY){
      const batch = orderIds.slice(i, i+CONCURRENCY);
      const parsed = await Promise.all(batch.map(async id => {
        try {
          const r = await fetch(`https://app.lojaintegrada.com.br/painel/pedido/${id}/detalhar`, {credentials:'include'});
          const html = await r.text();
          return parseOrderDetail(html, id);
        } catch(e){ return null; }
      }));
      for (const p of parsed){ if (p) results.push(p); }
      done += batch.length;
      setStatus(`Analisando ${done}/${orderIds.length}... (${results.length} com bordado)`);
      setProgress(30 + Math.round((done/orderIds.length)*70));
    }

    if (results.length === 0){
      setStatus('✓ Nenhum pedido com bordado nesta data.');
      setTimeout(() => panel.remove(), 5000);
      return;
    }
    setStatus(`Enviando ${results.length} pedidos pro app Dra Charm...`);
    if (!window.opener){
      setStatus('❌ Esta aba não foi aberta pelo app. Abre pelo botão do app.');
      return;
    }
    window.opener.postMessage({type:'draCharmBordados', orders: results}, APP_ORIGIN);
    setStatus(`✅ ${results.length} pedidos enviados. Volta pra aba do Dra Charm.`);
    setTimeout(() => window.close(), 2500);
  }
})();
