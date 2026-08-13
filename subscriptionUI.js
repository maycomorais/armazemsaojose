// subscriptionUI.js
// Barra de alerta global + tela de bloqueio + inicialização.
// Depende de: subscriptionDateUtils.js, subscriptionService.js

'use strict';

const SubscriptionUI = (() => {

  // ─────────────────────────────────────────────────────────────
  // CONFIG VISUAL
  // ─────────────────────────────────────────────────────────────

  const CORES = {
    em_dia:          null,                              // sem barra
    alerta_verde:    { bg: '#d1fae5', borda: '#34d399', texto: '#065f46', icone: '✅' },
    alerta_amarelo:  { bg: '#fef9c3', borda: '#facc15', texto: '#78350f', icone: '⚠️' },
    alerta_laranja:  { bg: '#ffedd5', borda: '#fb923c', texto: '#7c2d12', icone: '🔔' },
    carencia:        { bg: '#fee2e2', borda: '#f87171', texto: '#7f1d1d', icone: '🚨' },
    bloqueado:       null,                              // tela cheia
  };

  // ─────────────────────────────────────────────────────────────
  // MENSAGENS
  // ─────────────────────────────────────────────────────────────

  function _mensagem(statusObj) {
    const { status, diasParaVenc, diasParaBloc, dataVenc } = statusObj;
    const { formatarData } = window.SubscriptionDateUtils;
    const dataFmt = formatarData(dataVenc);

    const translate = (key, fallback) => (typeof t !== 'undefined' ? t(key, fallback) : fallback);

    switch (status) {
      case 'alerta_verde':
        return translate('sub.barra_vence', `O pagamento da mensalidade vence no dia <strong>{data}</strong>.`).replace('{data}', dataFmt);
      case 'alerta_amarelo':
        return translate('sub.barra_amanha', `O vencimento da mensalidade é <strong>amanhã</strong>.`);
      case 'alerta_laranja':
        return translate('sub.barra_hoje', `O vencimento da mensalidade é <strong>hoje</strong>.`);
      case 'carencia':
        return translate('sub.barra_carencia', `Atenção: Faltam <strong>{dias}</strong> dia(s) para o bloqueio do sistema por falta de pagamento.`).replace('{dias}', diasParaBloc);
      default:
        return '';
    }
  }

  // ─────────────────────────────────────────────────────────────
  // INJETAR ESTILOS GLOBAIS (uma vez)
  // ─────────────────────────────────────────────────────────────

  function _injetarEstilos() {
    if (document.getElementById('_subscription-styles')) return;
    const s = document.createElement('style');
    s.id = '_subscription-styles';
    s.textContent = `
      #subscription-alert-bar {
        width: 100%;
        padding: 10px 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        font-family: 'Rubik', sans-serif;
        font-size: 0.88rem;
        font-weight: 500;
        border-bottom: 2px solid transparent;
        transition: all 0.4s ease;
        z-index: 1000;
        position: relative;
        box-sizing: border-box;
      }
      #subscription-alert-bar .sub-bar-msg {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
      }
      #subscription-alert-bar .sub-bar-close {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 16px;
        opacity: 0.6;
        transition: opacity 0.2s;
        padding: 0;
        line-height: 1;
        flex-shrink: 0;
      }
      #subscription-alert-bar .sub-bar-close:hover { opacity: 1; }

      /* ── Tela de bloqueio ── */
      #subscription-block-screen {
        position: fixed;
        inset: 0;
        z-index: 99999;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #0f172a;
        font-family: 'Rubik', sans-serif;
      }
      #subscription-block-screen .block-card {
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 20px;
        padding: 48px 40px;
        max-width: 460px;
        width: 92%;
        text-align: center;
        box-shadow: 0 24px 60px rgba(0,0,0,0.5);
        animation: _blockFadeIn 0.5s ease;
      }
      @keyframes _blockFadeIn {
        from { opacity: 0; transform: translateY(24px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      #subscription-block-screen .block-icon {
        font-size: 56px;
        margin-bottom: 20px;
        display: block;
      }
      #subscription-block-screen h2 {
        color: #f1f5f9;
        font-size: 1.45rem;
        font-weight: 700;
        margin: 0 0 12px;
      }
      #subscription-block-screen p {
        color: #94a3b8;
        font-size: 0.92rem;
        line-height: 1.6;
        margin: 0 0 28px;
      }
      #subscription-block-screen .block-contato {
        background: #0f172a;
        border-radius: 12px;
        padding: 16px 20px;
        color: #64748b;
        font-size: 0.82rem;
      }
      #subscription-block-screen .block-contato strong {
        color: #94a3b8;
        display: block;
        margin-bottom: 6px;
        font-size: 0.85rem;
      }
      #subscription-block-screen .block-tel {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-top: 10px;
        background: #22c55e;
        color: #fff;
        padding: 9px 18px;
        border-radius: 8px;
        text-decoration: none;
        font-weight: 600;
        font-size: 0.88rem;
        transition: opacity 0.2s;
      }
      #subscription-block-screen .block-tel:hover { opacity: 0.85; }
    `;
    document.head.appendChild(s);
  }

  // ─────────────────────────────────────────────────────────────
  // BARRA DE ALERTA
  // ─────────────────────────────────────────────────────────────

  /**
   * Renderiza (ou remove) a barra de alerta no topo.
   * @param {object} statusObj — retorno de calcularStatusAssinatura()
   */
  function renderizarBarra(statusObj) {
    _injetarEstilos();
    const { status } = statusObj;
    const cor = CORES[status];

    // Remove a barra anterior
    const anterior = document.getElementById('subscription-alert-bar');
    if (anterior) anterior.remove();

    // Nenhuma barra para 'em_dia' ou 'bloqueado'
    if (!cor) return;

    const msg  = _mensagem(statusObj);
    const barra = document.createElement('div');
    barra.id    = 'subscription-alert-bar';
    barra.style.cssText = `
      background:${cor.bg};
      border-bottom-color:${cor.borda};
      color:${cor.texto};
    `;
    barra.innerHTML = `
      <div class="sub-bar-msg">
        <span style="font-size:16px;flex-shrink:0">${cor.icone}</span>
        <span>${msg}</span>
      </div>
      <button class="sub-bar-close" onclick="this.closest('#subscription-alert-bar').remove()"
        title="Fechar aviso">✕</button>
    `;

    // Insere antes do primeiro filho do body ou do main-content
    const mainContent = document.querySelector('.main-content') || document.body;
    mainContent.insertBefore(barra, mainContent.firstChild);
  }

  // ─────────────────────────────────────────────────────────────
  // TELA DE BLOQUEIO
  // ─────────────────────────────────────────────────────────────

  /**
   * Exibe tela de bloqueio total e oculta o conteúdo do app.
   * @param {string} contatoFone  — número de WhatsApp do suporte
   * @param {string} contatoNome  — nome do responsável
   */
  function exibirTelaBloqueio(contatoFone = '', contatoNome = 'Suporte') {
    _injetarEstilos();

    // Oculta todo o conteúdo existente
    document.querySelectorAll('body > *').forEach(el => {
      if (el.id !== 'subscription-block-screen') el.style.display = 'none';
    });

    // Remove tela anterior se existir
    const anterior = document.getElementById('subscription-block-screen');
    if (anterior) anterior.remove();

    const translate = (key, fallback) => (typeof t !== 'undefined' ? t(key, fallback) : fallback);

    const msgAjuda = translate('sub.mensagem_ajuda', 'Olá, preciso de ajuda com o bloqueio do sistema.');
    const zapLink = contatoFone
      ? `https://wa.me/${contatoFone.replace(/\D/g,'')}?text=${encodeURIComponent(msgAjuda)}`
      : null;

    const screen = document.createElement('div');
    screen.id = 'subscription-block-screen';
    screen.innerHTML = `
      <div class="block-card">
        <span class="block-icon">🔒</span>
        <h2>${translate('sub.bloqueado_titulo', 'Sistema Bloqueado')}</h2>
        <p>
          ${translate('sub.bloqueado_texto', 'O acesso foi suspenso por falta de pagamento da mensalidade.<br>Entre em contato com o administrador para regularizar e reativar o sistema.')}
        </p>
        <div class="block-contato">
          <strong>${translate('sub.contate_suporte', '📞 Contate o suporte:')}</strong>
          ${contatoNome}
          ${zapLink
            ? `<br><a href="${zapLink}" target="_blank" class="block-tel">
                <span>💬</span> ${translate('sub.falar_whatsapp', 'Falar no WhatsApp')}
               </a>`
            : ''}
        </div>
      </div>
    `;
    document.body.appendChild(screen);
  }

  /**
   * Remove a tela de bloqueio e restaura a visibilidade.
   */
  function removerTelaBloqueio() {
    const screen = document.getElementById('subscription-block-screen');
    if (screen) screen.remove();
    document.querySelectorAll('body > *').forEach(el => {
      el.style.display = '';
    });
  }

  // ─────────────────────────────────────────────────────────────
  // INICIALIZAÇÃO — chamado 1 vez no carregamento do app
  // ─────────────────────────────────────────────────────────────

  /**
   * Inicializa o controle de assinatura:
   * 1. Busca data do servidor (anti-tamper)
   * 2. Busca config da assinatura no Supabase
   * 3. Calcula status e renderiza barra ou tela de bloqueio
   * 4. Subscreve realtime para propagar bloqueio instantaneamente
   *
   * @param {object} opts
   * @param {string} opts.supabaseUrl
   * @param {string} opts.supabaseKey
   * @param {string} [opts.contatoFone]   — WhatsApp do suporte
   * @param {string} [opts.contatoNome]   — Nome do suporte
   */
  async function inicializar({ supabaseUrl, supabaseKey, contatoFone = '', contatoNome = 'Suporte', perfil = null }) {
    try {
      const { getServerDate, calcularStatusAssinatura } = window.SubscriptionDateUtils;

      // CORREÇÃO Bugs 1 + 4:
      // Antes: `const isGestor = window.perfilUsuario === 'adminMaster'`
      //   → leitura síncrona no momento do init (race condition: perfilUsuario ainda null)
      //   → closure capturava o valor null para sempre no listener realtime
      // Depois: getter lazy avaliado a cada chamada.
      //   O parâmetro `perfil` permite o caller passar o valor já resolvido,
      //   eliminando a corrida. O fallback para window.perfilUsuario cobre casos
      //   onde inicializar() é chamado antes da autenticação completar.
      const getIsGestor = () => (perfil ?? window.perfilUsuario) === 'adminMaster';

      // Paralelo: data do servidor + config da assinatura
      const [hoje, cfg] = await Promise.all([
        getServerDate(supabaseUrl, supabaseKey),
        SubscriptionService.getAssinatura(),
      ]);

      if (!cfg) {
        console.warn('[Assinatura] Configuração não encontrada. Acesso liberado.');
        return;
      }

      const statusObj = calcularStatusAssinatura(cfg, hoje);

      if (statusObj.status === 'bloqueado') {
        if (getIsGestor()) {
          // Gestor vê apenas barra vermelha de aviso, nunca tela de bloqueio
          renderizarBarra({ ...statusObj, status: 'carencia' });
        } else {
          exibirTelaBloqueio(contatoFone, contatoNome);
        }
      } else {
        renderizarBarra(statusObj);
      }

      // Realtime: propaga mudanças em tempo real
      // CORREÇÃO Bug 4: getIsGestor() é chamado dentro do callback (não capturado na closure),
      // então sempre reflete o perfilUsuario atualizado no momento do evento.
      SubscriptionService.assinarMudancas(async (novoCfg) => {
        const novoHoje = await getServerDate(supabaseUrl, supabaseKey);
        const novoStatus = calcularStatusAssinatura(novoCfg, novoHoje);
        if (novoStatus.status === 'bloqueado') {
          if (getIsGestor()) {
            renderizarBarra({ ...novoStatus, status: 'carencia' });
          } else {
            exibirTelaBloqueio(contatoFone, contatoNome);
          }
        } else {
          removerTelaBloqueio();
          renderizarBarra(novoStatus);
        }
      });

    } catch (err) {
      console.error('[Assinatura] Erro ao inicializar:', err);
      // Em caso de erro de rede, nunca bloqueia
    }
  }

  return {
    inicializar,
    renderizarBarra,
    exibirTelaBloqueio,
    removerTelaBloqueio,
  };

})();

if (typeof window !== 'undefined') {
  window.SubscriptionUI = SubscriptionUI;
}
