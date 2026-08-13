-- ═══════════════════════════════════════════════════════════════════════
--  SCHEMA COMPLETO — PLATAFORMA DE PEDIDOS / MERCADO / DELIVERY
--  Versão consolidada — todos os migrations em arquivo único
--  Seguro para re-executar (idempotente em todos os blocos)
--
--  ÍNDICE
--  ──────
--  §01  Extensões
--  §02  Funções auxiliares globais
--  §03  Tabelas: Identidade (configuracoes, perfis_acesso, perfis, filiais)
--  §04  Tabelas: Cardápio (categorias, subcategorias, produtos, produto_variacoes)
--  §05  Tabelas: Inventário (inventario, inventario_movimentos, insumos, fichas_tecnicas)
--  §06  Tabelas: Operação (motoboys, cupons, clientes, cashback_transacoes)
--  §07  Tabelas: Pedidos (pedidos, solicitacoes_cancelamento)
--  §08  Tabelas: Financeiro (sessoes_caixa, movimentacoes_caixa)
--  §09  Tabelas: Mensalistas (planos_mensalistas, mensalista_entregas)
--  §10  Tabelas: SaaS (assinaturas, assinatura_pagamentos)
--  §11  Tabelas: Legal (contratos_aceites)
--  §12  Colunas incrementais (ALTER TABLE IF NOT EXISTS)
--  §13  Índices
--  §14  Funções RPC e helpers
--  §15  Views auxiliares
--  §16  Row Level Security (RLS)
--  §17  Storage (bucket "produtos")
--  §18  Realtime
--  §19  Seeds obrigatórios
--  §20  Verificações finais
--
--  ► PROJETO NOVO      → execute o arquivo inteiro
--  ► PROJETO EXISTENTE → execute o arquivo inteiro (é idempotente)
-- ═══════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════
-- §01  EXTENSÕES
-- ═══════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ═══════════════════════════════════════════════════════════════════════
-- §02  FUNÇÕES AUXILIARES GLOBAIS
--      Declaradas antes das tabelas por serem usadas nos triggers.
-- ═══════════════════════════════════════════════════════════════════════

-- Atualiza updated_at automaticamente em qualquer tabela que use o trigger
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Alias antigo (mantido por compatibilidade com triggers existentes)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- Trigger updated_at para produto_variacoes
CREATE OR REPLACE FUNCTION _set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- §03  IDENTIDADE
-- ═══════════════════════════════════════════════════════════════════════

-- ── perfis_acesso ──────────────────────────────────────────────────────
-- Vinculado ao Supabase Auth. Hierarquia: adminMaster > dono > gerente > funcionario > garcom
CREATE TABLE IF NOT EXISTS perfis_acesso (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  cargo         TEXT NOT NULL DEFAULT 'funcionario'
                CHECK (cargo IN ('adminMaster','dono','gerente','funcionario','garcom')),
  nome_display  TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Garante constraint atualizada (inclui adminMaster)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'perfis_acesso_cargo_check' AND table_name = 'perfis_acesso'
  ) THEN
    ALTER TABLE public.perfis_acesso DROP CONSTRAINT perfis_acesso_cargo_check;
  END IF;
  ALTER TABLE public.perfis_acesso
    ADD CONSTRAINT perfis_acesso_cargo_check
    CHECK (cargo IN ('adminMaster','dono','gerente','funcionario','garcom'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── filiais ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS filiais (
  id                  UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                TEXT             NOT NULL,
  endereco            TEXT,
  coord_lat           DOUBLE PRECISION NOT NULL,
  coord_lng           DOUBLE PRECISION NOT NULL,
  whatsapp            TEXT             NOT NULL,
  status              TEXT             NOT NULL DEFAULT 'ativa'
                                       CHECK (status IN ('ativa','inativa','manutencao')),
  raio_entrega_km     DOUBLE PRECISION NOT NULL DEFAULT 10.0,
  taxa_entrega_base   NUMERIC(10,2)    DEFAULT 0,
  horario_abertura    TIME             DEFAULT '08:00',
  horario_fechamento  TIME             DEFAULT '22:00',
  created_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ      NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_filiais_updated_at ON filiais;
CREATE TRIGGER trg_filiais_updated_at
  BEFORE UPDATE ON filiais
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();


-- ── perfis ────────────────────────────────────────────────────────────
-- Tabela alternativa de perfis (multi-filial)
CREATE TABLE IF NOT EXISTS perfis (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT,
  nome        TEXT,
  role        TEXT        NOT NULL DEFAULT 'funcionario'
                          CHECK (role IN ('adminMaster','gerente','funcionario','motoboy')),
  filial_id   UUID        REFERENCES filiais(id) ON DELETE SET NULL,
  ativo       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (usuario_id)
);

-- Colunas incrementais de perfis (bancos antigos)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='perfis' AND column_name='role') THEN
    ALTER TABLE perfis ADD COLUMN role TEXT NOT NULL DEFAULT 'funcionario' CHECK (role IN ('adminMaster','gerente','funcionario','motoboy'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='perfis' AND column_name='filial_id') THEN
    ALTER TABLE perfis ADD COLUMN filial_id UUID REFERENCES filiais(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='perfis' AND column_name='ativo') THEN
    ALTER TABLE perfis ADD COLUMN ativo BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;
END $$;


-- ── configuracoes ─────────────────────────────────────────────────────
-- Linha única (id = 1). Todos os dados globais da loja.
CREATE TABLE IF NOT EXISTS configuracoes (
  id                          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Identidade
  nome_restaurante            TEXT          DEFAULT '',
  descricao_loja              TEXT          DEFAULT '',
  url_loja                    TEXT          DEFAULT '',
  telefone_loja               TEXT          DEFAULT '',
  whatsapp_loja               TEXT          DEFAULT '',
  logo_url                    TEXT          DEFAULT '',
  icone_url                   TEXT          DEFAULT '',
  -- Pagamento
  chave_pix                   TEXT          DEFAULT '',
  nome_pix                    TEXT          DEFAULT '',
  dados_alias                 TEXT          DEFAULT '',
  nome_alias                  TEXT          DEFAULT '',
  maquininhas_cartao          JSONB         DEFAULT '[]'::JSONB,
  alias_qr_url                TEXT          DEFAULT '',
  -- Localização e Delivery
  coord_lat                   DOUBLE PRECISION DEFAULT 0,
  coord_lng                   DOUBLE PRECISION DEFAULT 0,
  tabela_frete                JSONB         DEFAULT NULL,
  limite_distancia_km         NUMERIC(5,1)  DEFAULT NULL,
  delivery_aberto             BOOLEAN       DEFAULT TRUE,
  aviso_delivery              TEXT          DEFAULT '',
  -- Operação
  loja_aberta                 BOOLEAN       DEFAULT TRUE,
  cotacao_real                NUMERIC(10,2) DEFAULT 1100,
  taxa_motoboy_base           INTEGER       DEFAULT 0,
  ajuda_combustivel           INTEGER       DEFAULT 0,
  -- Horários
  horarios_semanais           JSONB         DEFAULT NULL,
  horario_extra_hoje          JSONB         DEFAULT NULL,
  -- Banners
  banner_imagem               TEXT          DEFAULT '',
  banner_produto_id           INTEGER       DEFAULT NULL,
  banner_desconto_tipo        TEXT          DEFAULT NULL,
  banner_desconto_valor       NUMERIC(10,2) DEFAULT NULL,
  banner2_imagem              TEXT          DEFAULT '',
  banner2_produto_id          INTEGER       DEFAULT NULL,
  banner2_desconto_tipo       TEXT          DEFAULT NULL,
  banner2_desconto_valor      NUMERIC(10,2) DEFAULT NULL,
  -- Visual
  cor_primaria                TEXT          DEFAULT '#1a7a2e',
  cor_secundaria              TEXT          DEFAULT '#155c24',
  -- Adicionais globais
  extras_globais              JSONB         DEFAULT '[]'::JSONB,
  extras_globais_categorias   JSONB         DEFAULT NULL,
  -- Financeiro / Caixa
  sangria_limite              INTEGER       DEFAULT NULL,
  caixa_status                JSONB         DEFAULT '{}'::JSONB,
  -- Cashback
  cashback_percentual         NUMERIC       DEFAULT 10,
  cashback_validade_dias      INT           DEFAULT 30,
  -- Conversor de moeda (BRL ↔ PYG)
  vc_config                   JSONB         DEFAULT '{"ativo":false,"taxa":0,"posicao":"abaixo"}'::JSONB,
  -- Features controladas pelo adminMaster
  features_ativas             JSONB         DEFAULT '{
    "tabs": {
      "pedidos": true, "cozinha": true, "pdv": true,
      "financeiro": true, "inventario": true, "equipe": true,
      "configuracoes": true, "dashboard": true
    },
    "tipos_produto": {
      "padrao": true, "bebida": true, "lanche": true, "pizza": true,
      "acai": true, "shake": true, "suco": true, "sorvete": true,
      "montavel": true, "combo": true, "variacoes": true, "kg": true
    },
    "funcionalidades": {
      "delivery": true, "retirada": true, "local": true, "balcao": true,
      "cupons": true, "factura": true, "multipagamento": true, "agendamento": true
    }
  }'::JSONB
);


-- ═══════════════════════════════════════════════════════════════════════
-- §04  CARDÁPIO
-- ═══════════════════════════════════════════════════════════════════════

-- ── categorias ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categorias (
  id                SERIAL PRIMARY KEY,
  slug              TEXT      NOT NULL UNIQUE,
  nome              TEXT      NOT NULL DEFAULT '',
  nome_exibicao     TEXT      NOT NULL DEFAULT '',
  descricao         TEXT      DEFAULT '',
  emoji             TEXT      DEFAULT '',
  cor               TEXT      DEFAULT '#1a7a2e',
  ordem             INTEGER   DEFAULT 0,
  ativa             BOOLEAN   DEFAULT TRUE,
  hora_inicio       TIME      DEFAULT NULL,
  hora_fim          TIME      DEFAULT NULL,
  dias_semana       TEXT[]    DEFAULT NULL,
  horarios_semanais JSONB     DEFAULT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Sincroniza nome ↔ nome_exibicao
CREATE OR REPLACE FUNCTION sync_cat_nome()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.nome IS NOT NULL AND NEW.nome != ''
     AND (NEW.nome_exibicao IS NULL OR NEW.nome_exibicao = '') THEN
    NEW.nome_exibicao := NEW.nome;
  END IF;
  IF NEW.nome_exibicao IS NOT NULL AND NEW.nome_exibicao != ''
     AND (NEW.nome IS NULL OR NEW.nome = '') THEN
    NEW.nome := NEW.nome_exibicao;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_cat_nome ON categorias;
CREATE TRIGGER trg_sync_cat_nome
  BEFORE INSERT OR UPDATE ON categorias
  FOR EACH ROW EXECUTE FUNCTION sync_cat_nome();

-- Sincroniza dados antigos
UPDATE public.categorias
  SET nome = nome_exibicao
  WHERE (nome = '' OR nome IS NULL) AND nome_exibicao IS NOT NULL;


-- ── subcategorias ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subcategorias (
  id              SERIAL PRIMARY KEY,
  slug            TEXT    NOT NULL UNIQUE,
  nome_exibicao   TEXT    NOT NULL,
  categoria_slug  TEXT    REFERENCES categorias(slug) ON DELETE CASCADE,
  ordem           INTEGER DEFAULT 0,
  ativa           BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Bancos antigos sem slug
UPDATE public.subcategorias
  SET slug = 'subcat-' || id
  WHERE slug IS NULL OR slug = '';

CREATE UNIQUE INDEX IF NOT EXISTS subcategorias_slug_unique
  ON public.subcategorias (slug);


-- ── produtos ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS produtos (
  id                 SERIAL PRIMARY KEY,
  nome               TEXT    NOT NULL,
  descricao          TEXT    DEFAULT '',
  preco              INTEGER DEFAULT 0,
  imagem_url         TEXT    DEFAULT '',
  categoria_slug     TEXT    REFERENCES categorias(slug) ON DELETE SET NULL,
  subcategoria_slug  TEXT    DEFAULT NULL,
  ativo              BOOLEAN DEFAULT TRUE,
  pausado            BOOLEAN DEFAULT FALSE,
  somente_balcao     BOOLEAN DEFAULT FALSE,
  destaque           BOOLEAN DEFAULT FALSE,
  ordem              INTEGER DEFAULT 0,
  e_montavel         BOOLEAN DEFAULT FALSE,
  montagem_config    JSONB   DEFAULT NULL,
  adicionais         JSONB   DEFAULT '[]'::JSONB,
  inventario_id      INTEGER DEFAULT NULL,
  estoque_qtd        INTEGER DEFAULT NULL,
  -- Varejo
  es_bebida          BOOLEAN DEFAULT FALSE,
  tem_variacoes      BOOLEAN NOT NULL DEFAULT FALSE,
  unidade_venda      TEXT    DEFAULT NULL,
  promo_ativo        BOOLEAN NOT NULL DEFAULT FALSE,
  promo_tipo         TEXT    DEFAULT 'percent' CHECK (promo_tipo IN ('percent','fixo', NULL)),
  promo_valor        NUMERIC(14,2) DEFAULT NULL,
  -- Código de barras (EAN-13, EAN-8, Code128, etc.)
  codigo_barras      TEXT    DEFAULT NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- FK subcategoria (safe)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_produtos_subcat' AND table_name = 'produtos'
  ) THEN
    ALTER TABLE produtos
      ADD CONSTRAINT fk_produtos_subcat
        FOREIGN KEY (subcategoria_slug)
        REFERENCES subcategorias(slug) ON DELETE SET NULL;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_produtos_updated_at ON produtos;
CREATE TRIGGER trg_produtos_updated_at
  BEFORE UPDATE ON produtos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── produto_variacoes ─────────────────────────────────────────────────
-- Uma linha por SKU vendável (tamanho, cor, sabor, voltagem…)
CREATE TABLE IF NOT EXISTS produto_variacoes (
  id                BIGSERIAL PRIMARY KEY,
  produto_id        BIGINT    NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  nome              TEXT      NOT NULL,
  sku               TEXT,
  preco_adicional   NUMERIC(14,2) NOT NULL DEFAULT 0,
  preco_absoluto    BOOLEAN   NOT NULL DEFAULT FALSE,
  estoque_qtd       INT       NOT NULL DEFAULT 0 CHECK (estoque_qtd >= 0),
  controlar_estoque BOOLEAN   NOT NULL DEFAULT TRUE,
  ativo             BOOLEAN   NOT NULL DEFAULT TRUE,
  ordem             SMALLINT  NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_pv_updated_at ON produto_variacoes;
CREATE TRIGGER trg_pv_updated_at
  BEFORE UPDATE ON produto_variacoes
  FOR EACH ROW EXECUTE FUNCTION _set_updated_at();

-- Sincroniza tem_variacoes na tabela produtos
CREATE OR REPLACE FUNCTION _sync_tem_variacoes()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE _pid BIGINT; _tem BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN _pid := OLD.produto_id; ELSE _pid := NEW.produto_id; END IF;
  SELECT EXISTS (
    SELECT 1 FROM produto_variacoes WHERE produto_id = _pid AND ativo = TRUE
  ) INTO _tem;
  UPDATE produtos SET tem_variacoes = _tem WHERE id = _pid;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_variacoes ON produto_variacoes;
CREATE TRIGGER trg_sync_variacoes
  AFTER INSERT OR UPDATE OR DELETE ON produto_variacoes
  FOR EACH ROW EXECUTE FUNCTION _sync_tem_variacoes();


-- ═══════════════════════════════════════════════════════════════════════
-- §05  INVENTÁRIO
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS inventario (
  id                SERIAL PRIMARY KEY,
  nome              TEXT          NOT NULL,
  unidade           TEXT          DEFAULT 'un',
  quantidade        NUMERIC(10,3) DEFAULT 0,
  quantidade_minima NUMERIC(10,3) DEFAULT NULL,
  custo_unit        INTEGER       DEFAULT 0,
  produto_id        INTEGER       DEFAULT NULL,
  perecivel         BOOLEAN       DEFAULT FALSE,
  data_validade     DATE          DEFAULT NULL,
  observacoes       TEXT          DEFAULT NULL,
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventario_movimentos (
  id              SERIAL PRIMARY KEY,
  inventario_id   INTEGER REFERENCES inventario(id) ON DELETE CASCADE,
  tipo            TEXT    NOT NULL CHECK (tipo IN ('add','sub','ajuste','fechamento')),
  quantidade      NUMERIC(10,3) NOT NULL DEFAULT 0,
  motivo          TEXT    DEFAULT '',
  usuario_email   TEXT    DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Insumos (matérias-primas / ficha técnica)
CREATE TABLE IF NOT EXISTS insumos (
  id            BIGSERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  unidade       TEXT NOT NULL DEFAULT 'un',
  preco_custo   NUMERIC NOT NULL DEFAULT 0,
  estoque_atual NUMERIC DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fichas_tecnicas (
  id             BIGSERIAL PRIMARY KEY,
  produto_id     TEXT,
  produto_nome   TEXT NOT NULL,
  markup_percent NUMERIC NOT NULL DEFAULT 300,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ficha_itens (
  id              BIGSERIAL PRIMARY KEY,
  ficha_id        BIGINT REFERENCES fichas_tecnicas(id) ON DELETE CASCADE,
  insumo_id       BIGINT REFERENCES insumos(id) ON DELETE SET NULL,
  insumo_nome     TEXT,
  unidade_insumo  TEXT DEFAULT 'un',
  quantidade      NUMERIC NOT NULL DEFAULT 1
);


-- ═══════════════════════════════════════════════════════════════════════
-- §06  OPERAÇÃO (motoboys, cupons, clientes, cashback)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS motoboys (
  id         SERIAL PRIMARY KEY,
  nome       TEXT    NOT NULL,
  telefone   TEXT    DEFAULT '',
  ativo      BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cupons (
  id              SERIAL PRIMARY KEY,
  codigo          TEXT          NOT NULL UNIQUE,
  tipo            TEXT          NOT NULL CHECK (tipo IN ('percentual','fixo','frete')),
  valor           NUMERIC(10,2) DEFAULT 0,
  minimo          NUMERIC(10,2) DEFAULT 0,
  limite_uso      INTEGER       DEFAULT NULL,
  usos_realizados INTEGER       DEFAULT 0,
  ativo           BOOLEAN       DEFAULT TRUE,
  validade        DATE          DEFAULT NULL,
  created_at      TIMESTAMPTZ   DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clientes (
  id               BIGSERIAL PRIMARY KEY,
  nome             TEXT NOT NULL,
  telefone         TEXT UNIQUE NOT NULL,
  data_nascimento  DATE,
  saldo_cashback   NUMERIC DEFAULT 0,
  total_gasto      NUMERIC DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cashback_transacoes (
  id                BIGSERIAL PRIMARY KEY,
  cliente_id        BIGINT REFERENCES clientes(id) ON DELETE CASCADE,
  cliente_telefone  TEXT,
  pedido_id         BIGINT,
  tipo              TEXT NOT NULL CHECK (tipo IN ('credito','debito')),
  valor             NUMERIC NOT NULL,
  validade_dias     INT DEFAULT 30,
  expira_em         TIMESTAMPTZ,
  usado             BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════
-- §07  PEDIDOS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pedidos (
  id                            SERIAL PRIMARY KEY,
  uid_temporal                  TEXT    DEFAULT '',
  status                        TEXT    DEFAULT 'pendente'
    CHECK (status IN ('pendente','em_preparo','pronto_entrega','saiu_entrega','entregue','cancelado')),
  tipo_entrega                  TEXT    DEFAULT 'delivery'
    CHECK (tipo_entrega IN ('delivery','retirada','local','balcao')),
  itens                         JSONB   DEFAULT '[]'::JSONB,
  -- Valores
  subtotal                      INTEGER DEFAULT 0,
  desconto_cupom                INTEGER DEFAULT 0,
  desconto_pdv_valor            INTEGER DEFAULT 0,
  desconto_pdv_tipo             TEXT    DEFAULT NULL,
  frete_cobrado_cliente         INTEGER DEFAULT 0,
  frete_motoboy                 INTEGER DEFAULT 0,
  frete_a_combinar              BOOLEAN DEFAULT FALSE,
  total_geral                   INTEGER DEFAULT 0,
  -- Pagamento
  forma_pagamento               TEXT    DEFAULT '',
  obs_pagamento                 TEXT    DEFAULT '',
  -- Cliente
  cliente_nome                  TEXT    DEFAULT '',
  cliente_telefone              TEXT    DEFAULT '',
  endereco_entrega              TEXT    DEFAULT '',
  geo_lat                       TEXT    DEFAULT NULL,
  geo_lng                       TEXT    DEFAULT NULL,
  dados_factura                 JSONB   DEFAULT NULL,
  -- Operadores
  motoboy_id                    INTEGER REFERENCES motoboys(id) ON DELETE SET NULL,
  garcom_id                     UUID    REFERENCES perfis_acesso(id) ON DELETE SET NULL,
  garcom_nome                   TEXT    DEFAULT NULL,
  filial_id                     UUID    REFERENCES filiais(id) ON DELETE SET NULL,
  -- Cancelamento
  cancelamento_solicitado       BOOLEAN     DEFAULT FALSE,
  cancelamento_motivo           TEXT        DEFAULT NULL,
  cancelamento_solicitado_por   TEXT        DEFAULT NULL,
  cancelamento_solicitado_em    TIMESTAMPTZ DEFAULT NULL,
  cancelamento_aprovado_por     TEXT        DEFAULT NULL,
  cancelamento_aprovado_em      TIMESTAMPTZ DEFAULT NULL,
  motivo_cancelamento           TEXT        DEFAULT NULL,
  -- Extras
  confirmacao_tipo              TEXT        DEFAULT NULL,
  cupom_codigo                  TEXT        DEFAULT NULL,
  push_subscription             JSONB       DEFAULT NULL,
  entrega_confirmada_em         TIMESTAMPTZ DEFAULT NULL,
  -- Timestamps do ciclo de vida
  tempo_recebido                TIMESTAMPTZ DEFAULT NOW(),
  tempo_confirmado              TIMESTAMPTZ DEFAULT NULL,
  tempo_preparo_iniciado        TIMESTAMPTZ DEFAULT NULL,
  tempo_pronto                  TIMESTAMPTZ DEFAULT NULL,
  tempo_saiu_entrega            TIMESTAMPTZ DEFAULT NULL,
  tempo_entregue                TIMESTAMPTZ DEFAULT NULL,
  created_at                    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS solicitacoes_cancelamento (
  id              SERIAL PRIMARY KEY,
  pedido_id       INTEGER REFERENCES pedidos(id) ON DELETE CASCADE,
  motivo          TEXT    DEFAULT '',
  solicitado_por  TEXT    DEFAULT '',
  aprovado        BOOLEAN DEFAULT FALSE,
  aprovado_por    TEXT    DEFAULT NULL,
  aprovado_em     TIMESTAMPTZ DEFAULT NULL,
  negado          BOOLEAN DEFAULT FALSE,
  negado_por      TEXT    DEFAULT NULL,
  negado_em       TIMESTAMPTZ DEFAULT NULL,
  observacoes     TEXT    DEFAULT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════
-- §08  FINANCEIRO (caixa)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sessoes_caixa (
  id               BIGSERIAL PRIMARY KEY,
  usuario_email    TEXT        NOT NULL,
  usuario_nome     TEXT,
  aberto_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fechado_em       TIMESTAMPTZ,
  valor_abertura   NUMERIC     DEFAULT 0,
  valor_fechamento NUMERIC,
  observacao       TEXT
);

CREATE TABLE IF NOT EXISTS movimentacoes_caixa (
  id               SERIAL PRIMARY KEY,
  tipo             TEXT          NOT NULL DEFAULT 'entrada',
  valor            NUMERIC(12,2) NOT NULL DEFAULT 0,
  descricao        TEXT          DEFAULT '',
  usuario_email    TEXT          DEFAULT '',
  tipo_despesa     TEXT          DEFAULT NULL,
  descricao_outro  TEXT          DEFAULT NULL,
  autorizado_por   TEXT          DEFAULT NULL,
  pedido_id        INTEGER       DEFAULT NULL,
  sessao_id        BIGINT        REFERENCES sessoes_caixa(id),
  created_at       TIMESTAMPTZ   DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════
-- §09  MENSALISTAS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS planos_mensalistas (
  id                  BIGSERIAL PRIMARY KEY,
  cliente_id          BIGINT REFERENCES clientes(id) ON DELETE CASCADE,
  produto_nome        TEXT NOT NULL,
  quantidade_total    INT NOT NULL DEFAULT 0,
  quantidade_restante INT NOT NULL DEFAULT 0,
  valor_plano         NUMERIC(12,2) NOT NULL DEFAULT 0,
  ativo               BOOLEAN NOT NULL DEFAULT TRUE,
  data_inicio         DATE,
  data_fim            DATE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mensalista_entregas (
  id           BIGSERIAL PRIMARY KEY,
  plano_id     BIGINT REFERENCES planos_mensalistas(id) ON DELETE CASCADE,
  cliente_id   BIGINT REFERENCES clientes(id) ON DELETE SET NULL,
  produto_nome TEXT,
  quantidade   INT NOT NULL DEFAULT 1,
  observacoes  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════
-- §10  SAAS — ASSINATURAS (controle de inadimplência)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.assinaturas (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_nome            TEXT    NOT NULL DEFAULT 'Loja Principal',
  tenant_email_contato   TEXT,
  tipo_vencimento        TEXT    NOT NULL DEFAULT 'dia_fixo'
                                 CHECK (tipo_vencimento IN ('dia_fixo','dia_util')),
  dia_vencimento         INTEGER NOT NULL DEFAULT 5
                                 CHECK (dia_vencimento BETWEEN 1 AND 31),
  dias_carencia          INTEGER NOT NULL DEFAULT 5 CHECK (dias_carencia >= 0),
  ultimo_pagamento_em    DATE,
  pagamento_confirmado_por TEXT,
  bloqueado              BOOLEAN NOT NULL DEFAULT FALSE,
  bloqueado_em           TIMESTAMPTZ,
  desbloqueado_em        TIMESTAMPTZ,
  desbloqueado_por       TEXT,
  obs                    TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_assinaturas_updated_at ON public.assinaturas;
CREATE TRIGGER trg_assinaturas_updated_at
  BEFORE UPDATE ON public.assinaturas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.assinatura_pagamentos (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assinatura_id   BIGINT NOT NULL REFERENCES public.assinaturas(id) ON DELETE CASCADE,
  competencia     TEXT   NOT NULL,
  confirmado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmado_por  TEXT,
  obs             TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pagamento_competencia
  ON public.assinatura_pagamentos (assinatura_id, competencia);


-- ═══════════════════════════════════════════════════════════════════════
-- §11  LEGAL — CONTRATOS DE ACEITE
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS contratos_aceites (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  email             TEXT        NOT NULL,
  nome_cliente      TEXT,
  documento_cliente TEXT,
  data_hora         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address        TEXT,
  user_agent        TEXT,
  aceito            BOOLEAN     NOT NULL DEFAULT TRUE,
  versao_contrato   TEXT        NOT NULL DEFAULT 'v1.0-2026',
  hash_contrato     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Registros de contratos são imutáveis (auditoria legal)
CREATE OR REPLACE FUNCTION fn_block_delete_contratos() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'OPERAÇÃO ILEGAL: registros de contratos_aceites não podem ser excluídos.'; END;
$$;
DROP TRIGGER IF EXISTS trg_block_delete_contratos ON contratos_aceites;
CREATE TRIGGER trg_block_delete_contratos
  BEFORE DELETE ON contratos_aceites FOR EACH ROW EXECUTE FUNCTION fn_block_delete_contratos();

CREATE OR REPLACE FUNCTION fn_block_update_contratos() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'OPERAÇÃO ILEGAL: registros de contratos_aceites são imutáveis.'; END;
$$;
DROP TRIGGER IF EXISTS trg_block_update_contratos ON contratos_aceites;
CREATE TRIGGER trg_block_update_contratos
  BEFORE UPDATE ON contratos_aceites FOR EACH ROW EXECUTE FUNCTION fn_block_update_contratos();


-- ═══════════════════════════════════════════════════════════════════════
-- §12  COLUNAS INCREMENTAIS
--      Seguro para bancos já existentes. Todas idempotentes.
-- ═══════════════════════════════════════════════════════════════════════

-- configuracoes
ALTER TABLE public.configuracoes
  ADD COLUMN IF NOT EXISTS nome_restaurante          TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS descricao_loja            TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS url_loja                  TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS telefone_loja             TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS whatsapp_loja             TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS logo_url                  TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS icone_url                 TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS chave_pix                 TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS nome_pix                  TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS dados_alias               TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS nome_alias                TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS maquininhas_cartao         JSONB         DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS alias_qr_url              TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS coord_lat                 DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coord_lng                 DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tabela_frete              JSONB         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS limite_distancia_km       NUMERIC(5,1)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS delivery_aberto           BOOLEAN       DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS aviso_delivery            TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS loja_aberta               BOOLEAN       DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS cotacao_real              NUMERIC(10,2) DEFAULT 1100,
  ADD COLUMN IF NOT EXISTS taxa_motoboy_base         INTEGER       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ajuda_combustivel         INTEGER       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS horarios_semanais         JSONB         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS horario_extra_hoje        JSONB         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banner_imagem             TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS banner_produto_id         INTEGER       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banner_desconto_tipo      TEXT          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banner_desconto_valor     NUMERIC(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banner2_imagem            TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS banner2_produto_id        INTEGER       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banner2_desconto_tipo     TEXT          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banner2_desconto_valor    NUMERIC(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cor_primaria              TEXT          DEFAULT '#1a7a2e',
  ADD COLUMN IF NOT EXISTS cor_secundaria            TEXT          DEFAULT '#155c24',
  ADD COLUMN IF NOT EXISTS extras_globais            JSONB         DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS extras_globais_categorias JSONB         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sangria_limite            INTEGER       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS caixa_status              JSONB         DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS cashback_percentual       NUMERIC       DEFAULT 10,
  ADD COLUMN IF NOT EXISTS cashback_validade_dias    INT           DEFAULT 30,
  ADD COLUMN IF NOT EXISTS vc_config                 JSONB         DEFAULT '{"ativo":false,"taxa":0,"posicao":"abaixo"}'::JSONB,
  ADD COLUMN IF NOT EXISTS features_ativas           JSONB         DEFAULT NULL;

UPDATE public.configuracoes SET loja_aberta = TRUE WHERE loja_aberta IS NULL;

-- produtos
ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS e_montavel        BOOLEAN       DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS subcategoria_slug TEXT          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS somente_balcao    BOOLEAN       DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS destaque          BOOLEAN       DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS inventario_id     INTEGER       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS estoque_qtd       INTEGER       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ   DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS es_bebida         BOOLEAN       DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tem_variacoes     BOOLEAN       DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS unidade_venda     TEXT          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS promo_ativo       BOOLEAN       DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS promo_tipo        TEXT          DEFAULT 'percent',
  ADD COLUMN IF NOT EXISTS promo_valor       NUMERIC(14,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS codigo_barras     TEXT          DEFAULT NULL;

-- categorias
ALTER TABLE public.categorias
  ADD COLUMN IF NOT EXISTS nome              TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS emoji             TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS dias_semana       TEXT[]  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS horarios_semanais JSONB   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS hora_inicio       TIME    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS hora_fim          TIME    DEFAULT NULL;

-- pedidos
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS frete_a_combinar           BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS desconto_pdv_valor          INTEGER     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS desconto_pdv_tipo           TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS garcom_nome                 TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS filial_id                   UUID        REFERENCES filiais(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelamento_solicitado     BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cancelamento_motivo         TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancelamento_solicitado_por TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancelamento_solicitado_em  TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancelamento_aprovado_por   TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancelamento_aprovado_em    TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS motivo_cancelamento         TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS confirmacao_tipo            TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cupom_codigo                TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS push_subscription           JSONB       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS entrega_confirmada_em       TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tempo_confirmado            TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tempo_preparo_iniciado      TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tempo_pronto                TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tempo_saiu_entrega          TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tempo_entregue              TIMESTAMPTZ DEFAULT NULL;

-- inventario
ALTER TABLE public.inventario
  ADD COLUMN IF NOT EXISTS quantidade_minima NUMERIC(10,3) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS produto_id        INTEGER       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS perecivel         BOOLEAN       DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS data_validade     DATE          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS observacoes       TEXT          DEFAULT NULL;

-- Migra coluna 'minimo' → 'quantidade_minima' se existir
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventario' AND column_name = 'minimo'
  ) THEN
    UPDATE public.inventario
      SET quantidade_minima = minimo
      WHERE quantidade_minima IS NULL AND minimo IS NOT NULL AND minimo > 0;
  END IF;
END $$;

-- cupons
ALTER TABLE public.cupons
  ADD COLUMN IF NOT EXISTS minimo     NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS limite_uso INTEGER       DEFAULT NULL;

-- Migra uso_maximo → limite_uso
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cupons' AND column_name = 'uso_maximo'
  ) THEN
    UPDATE public.cupons SET limite_uso = uso_maximo WHERE limite_uso IS NULL AND uso_maximo IS NOT NULL;
  END IF;
END $$;

-- movimentacoes_caixa
ALTER TABLE public.movimentacoes_caixa
  ADD COLUMN IF NOT EXISTS tipo_despesa    TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS descricao_outro TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS autorizado_por  TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pedido_id       INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sessao_id       BIGINT  REFERENCES sessoes_caixa(id);

-- Migração código de barras: move "Cód: XXXX" da descrição para codigo_barras
UPDATE public.produtos
SET
  codigo_barras = TRIM(REPLACE(descricao, 'Cód: ', '')),
  descricao     = ''
WHERE descricao LIKE 'Cód: %'
  AND (codigo_barras IS NULL OR codigo_barras = '');


-- ═══════════════════════════════════════════════════════════════════════
-- §13  ÍNDICES
-- ═══════════════════════════════════════════════════════════════════════

-- Pedidos
CREATE INDEX IF NOT EXISTS idx_pedidos_status        ON pedidos (status);
CREATE INDEX IF NOT EXISTS idx_pedidos_created_at    ON pedidos (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_garcom        ON pedidos (garcom_id) WHERE garcom_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pedidos_garcom_status ON pedidos (garcom_id, status) WHERE garcom_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pedidos_filial_id     ON pedidos (filial_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_push_subscription ON pedidos ((push_subscription IS NOT NULL)) WHERE push_subscription IS NOT NULL;

-- Produtos
CREATE INDEX IF NOT EXISTS idx_produtos_cat      ON produtos (categoria_slug);
CREATE INDEX IF NOT EXISTS idx_produtos_ativo    ON produtos (ativo);
CREATE INDEX IF NOT EXISTS idx_produtos_subcat   ON produtos (subcategoria_slug);
CREATE INDEX IF NOT EXISTS idx_produtos_destaque ON produtos (destaque) WHERE destaque = TRUE AND ativo = TRUE;

-- Código de barras: índice único parcial (permite múltiplos NULLs)
CREATE UNIQUE INDEX IF NOT EXISTS idx_produtos_codigo_barras
  ON public.produtos (codigo_barras)
  WHERE codigo_barras IS NOT NULL AND codigo_barras <> '';

-- Produto variações
CREATE INDEX IF NOT EXISTS idx_pv_produto_id ON produto_variacoes (produto_id, ordem);
CREATE INDEX IF NOT EXISTS idx_pv_sku        ON produto_variacoes (sku) WHERE sku IS NOT NULL;

-- Subcategorias / categorias
CREATE INDEX IF NOT EXISTS idx_subcategorias_cat ON subcategorias (categoria_slug);

-- Inventário
CREATE INDEX IF NOT EXISTS idx_inv_mov_inv ON inventario_movimentos (inventario_id);

-- Caixa
CREATE INDEX IF NOT EXISTS idx_caixa_created  ON movimentacoes_caixa (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_caixa_operador ON movimentacoes_caixa (usuario_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes_caixa (usuario_email);
CREATE INDEX IF NOT EXISTS idx_sessoes_aberto  ON sessoes_caixa (aberto_em);

-- Cupons
CREATE INDEX IF NOT EXISTS idx_cupons_codigo ON cupons (codigo);

-- Cancelamentos
CREATE INDEX IF NOT EXISTS idx_sol_cancel_pedido ON solicitacoes_cancelamento (pedido_id);

-- Clientes / Cashback
CREATE INDEX IF NOT EXISTS idx_clientes_telefone ON clientes (telefone);
CREATE INDEX IF NOT EXISTS idx_cashback_cliente  ON cashback_transacoes (cliente_id);

-- Mensalistas
CREATE INDEX IF NOT EXISTS idx_planos_mensalistas_cliente ON planos_mensalistas (cliente_id);
CREATE INDEX IF NOT EXISTS idx_planos_mensalistas_ativo   ON planos_mensalistas (ativo);
CREATE INDEX IF NOT EXISTS idx_mensalista_entregas_plano  ON mensalista_entregas (plano_id);
CREATE INDEX IF NOT EXISTS idx_mensalista_entregas_data   ON mensalista_entregas (created_at);

-- Filiais / Perfis
CREATE INDEX IF NOT EXISTS idx_filiais_status   ON filiais (status);
CREATE INDEX IF NOT EXISTS idx_perfis_usuario_id ON perfis (usuario_id);
CREATE INDEX IF NOT EXISTS idx_perfis_filial_id  ON perfis (filial_id);
CREATE INDEX IF NOT EXISTS idx_perfis_role       ON perfis (role);

-- Contratos
CREATE INDEX IF NOT EXISTS idx_contratos_usuario_id ON contratos_aceites (usuario_id);
CREATE INDEX IF NOT EXISTS idx_contratos_email       ON contratos_aceites (email);


-- ═══════════════════════════════════════════════════════════════════════
-- §14  FUNÇÕES RPC E HELPERS
-- ═══════════════════════════════════════════════════════════════════════

-- Decrementa estoque de variação com lock atômico
CREATE OR REPLACE FUNCTION decrementar_estoque_variacao(
  p_variacao_id BIGINT,
  p_quantidade  INT DEFAULT 1
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE _atual INT; _controlar BOOLEAN;
BEGIN
  SELECT estoque_qtd, controlar_estoque INTO _atual, _controlar
  FROM produto_variacoes WHERE id = p_variacao_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'erro', 'Variação não encontrada');
  END IF;
  IF NOT _controlar THEN
    RETURN json_build_object('ok', true, 'estoque_restante', NULL);
  END IF;
  IF _atual < p_quantidade THEN
    RETURN json_build_object('ok', false, 'erro', 'Estoque insuficiente', 'disponivel', _atual);
  END IF;
  UPDATE produto_variacoes SET estoque_qtd = estoque_qtd - p_quantidade WHERE id = p_variacao_id;
  RETURN json_build_object('ok', true, 'estoque_restante', _atual - p_quantidade);
END;
$$;

-- Incrementa uso de cupom (atômico, evita race condition)
CREATE OR REPLACE FUNCTION incrementar_uso_cupom(cupom_id INTEGER)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE cupons SET usos_realizados = COALESCE(usos_realizados, 0) + 1 WHERE id = cupom_id;
$$;
GRANT EXECUTE ON FUNCTION incrementar_uso_cupom(INTEGER) TO anon, authenticated;

-- Helpers de perfil multi-filial
CREATE OR REPLACE FUNCTION get_my_role() RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(role, 'funcionario') FROM perfis WHERE usuario_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_my_filial_id() RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT filial_id FROM perfis WHERE usuario_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION usuario_tem_contrato(p_uid UUID DEFAULT auth.uid()) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM contratos_aceites WHERE usuario_id = p_uid AND aceito = TRUE);
$$;

-- Filial mais próxima (haversine)
CREATE OR REPLACE FUNCTION filial_mais_proxima(p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION)
RETURNS TABLE (filial_id UUID, nome TEXT, whatsapp TEXT, endereco TEXT, distancia_km DOUBLE PRECISION, raio_entrega_km DOUBLE PRECISION, dentro_do_raio BOOLEAN)
LANGUAGE sql STABLE AS $$
  SELECT id, nome, whatsapp, endereco,
    (6371.0 * acos(LEAST(1.0,
      cos(radians(p_lat)) * cos(radians(coord_lat)) * cos(radians(coord_lng) - radians(p_lng))
      + sin(radians(p_lat)) * sin(radians(coord_lat))
    ))) AS distancia_km,
    raio_entrega_km,
    (6371.0 * acos(LEAST(1.0,
      cos(radians(p_lat)) * cos(radians(coord_lat)) * cos(radians(coord_lng) - radians(p_lng))
      + sin(radians(p_lat)) * sin(radians(coord_lat))
    ))) <= raio_entrega_km AS dentro_do_raio
  FROM filiais WHERE status = 'ativa' ORDER BY distancia_km ASC LIMIT 1;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- §15  VIEWS AUXILIARES
-- ═══════════════════════════════════════════════════════════════════════

-- Variações com estoque baixo (≤ 5)
CREATE OR REPLACE VIEW produtos_com_estoque AS
SELECT
  p.id          AS produto_id,
  p.nome        AS produto_nome,
  p.categoria_slug,
  pv.id         AS variacao_id,
  pv.nome       AS variacao_nome,
  pv.sku,
  pv.estoque_qtd,
  pv.controlar_estoque,
  pv.preco_adicional,
  pv.preco_absoluto,
  pv.ativo
FROM produto_variacoes pv
JOIN produtos p ON p.id = pv.produto_id
ORDER BY p.nome, pv.ordem, pv.nome;

-- Produtos em promoção
CREATE OR REPLACE VIEW produtos_em_promocao AS
SELECT
  id, nome, categoria_slug, preco,
  promo_tipo, promo_valor,
  CASE
    WHEN promo_tipo = 'percent' THEN ROUND(preco * (1 - promo_valor / 100))
    WHEN promo_tipo = 'fixo'    THEN ROUND(preco - promo_valor)
    ELSE preco
  END AS preco_final,
  imagem_url, destaque, unidade_venda
FROM produtos
WHERE ativo = TRUE AND promo_ativo = TRUE
ORDER BY destaque DESC, nome;


-- ═══════════════════════════════════════════════════════════════════════
-- §16  ROW LEVEL SECURITY (RLS)
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE pedidos                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorias                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuracoes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfis_acesso              ENABLE ROW LEVEL SECURITY;
ALTER TABLE motoboys                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE cupons                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventario                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventario_movimentos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE subcategorias              ENABLE ROW LEVEL SECURITY;
ALTER TABLE solicitacoes_cancelamento  ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimentacoes_caixa        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessoes_caixa              ENABLE ROW LEVEL SECURITY;
ALTER TABLE produto_variacoes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE insumos                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichas_tecnicas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ficha_itens                ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashback_transacoes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE planos_mensalistas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensalista_entregas        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assinaturas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assinatura_pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE filiais                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfis                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE contratos_aceites          ENABLE ROW LEVEL SECURITY;

-- Políticas (todas idempotentes via DO $$)
DO $$ BEGIN

  -- ── Leitura pública: cardápio ──────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='produtos'      AND policyname='anon_read_produtos')      THEN CREATE POLICY "anon_read_produtos"      ON produtos      FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='categorias'    AND policyname='anon_read_categorias')    THEN CREATE POLICY "anon_read_categorias"    ON categorias    FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='subcategorias' AND policyname='anon_read_subcats')       THEN CREATE POLICY "anon_read_subcats"       ON subcategorias FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='configuracoes' AND policyname='anon_read_config')        THEN CREATE POLICY "anon_read_config"        ON configuracoes FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cupons'        AND policyname='anon_read_cupons')        THEN CREATE POLICY "anon_read_cupons"        ON cupons        FOR SELECT USING (ativo = true); END IF;

  -- ── Variações públicas ─────────────────────────────────────────────
  DROP POLICY IF EXISTS pv_select_public ON produto_variacoes;
  CREATE POLICY pv_select_public ON produto_variacoes FOR SELECT USING (ativo = TRUE);
  DROP POLICY IF EXISTS pv_write_auth ON produto_variacoes;
  CREATE POLICY pv_write_auth ON produto_variacoes FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

  -- ── Pedidos: leitura/update público, insert anon, gestão autenticada ─
  DROP POLICY IF EXISTS "Clientes podem inserir pedidos"    ON pedidos;
  DROP POLICY IF EXISTS "Allow insert for anon"             ON pedidos;
  DROP POLICY IF EXISTS "Enable insert for anon"            ON pedidos;
  DROP POLICY IF EXISTS "insert_pedidos"                    ON pedidos;
  DROP POLICY IF EXISTS "anon_insert_pedidos"               ON pedidos;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pedidos' AND policyname='pedidos_select_publico') THEN
    CREATE POLICY "pedidos_select_publico" ON pedidos FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pedidos' AND policyname='pedidos_update_publico') THEN
    CREATE POLICY "pedidos_update_publico" ON pedidos FOR UPDATE USING (true);
  END IF;

  DROP POLICY IF EXISTS "pedidos_select_filial" ON pedidos;
  DROP POLICY IF EXISTS "pedidos_insert_filial" ON pedidos;
  DROP POLICY IF EXISTS "pedidos_update_filial" ON pedidos;
  DROP POLICY IF EXISTS "pedidos_insert_anon"   ON pedidos;
  CREATE POLICY "pedidos_select_filial" ON pedidos FOR SELECT  TO authenticated USING (get_my_role() = 'adminMaster' OR filial_id = get_my_filial_id() OR filial_id IS NULL);
  CREATE POLICY "pedidos_insert_anon"   ON pedidos FOR INSERT  TO anon, authenticated WITH CHECK (TRUE);
  CREATE POLICY "pedidos_update_filial" ON pedidos FOR UPDATE  TO authenticated USING (get_my_role() = 'adminMaster' OR filial_id = get_my_filial_id() OR filial_id IS NULL);

  -- ── Solicitações de cancelamento ───────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='solicitacoes_cancelamento' AND policyname='anon_insert_solicitacoes') THEN
    CREATE POLICY "anon_insert_solicitacoes" ON solicitacoes_cancelamento FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='solicitacoes_cancelamento' AND policyname='auth_all_solicitacoes') THEN
    CREATE POLICY "auth_all_solicitacoes" ON solicitacoes_cancelamento FOR ALL USING (auth.role() = 'authenticated');
  END IF;

  -- ── Demais tabelas: só autenticados ───────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='produtos'             AND policyname='auth_all_produtos')      THEN CREATE POLICY "auth_all_produtos"      ON produtos             FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='categorias'           AND policyname='auth_all_categorias')    THEN CREATE POLICY "auth_all_categorias"    ON categorias           FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='subcategorias'        AND policyname='auth_all_subcats')       THEN CREATE POLICY "auth_all_subcats"       ON subcategorias        FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='configuracoes'        AND policyname='auth_all_config')        THEN CREATE POLICY "auth_all_config"        ON configuracoes        FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='perfis_acesso'        AND policyname='auth_all_perfis')        THEN CREATE POLICY "auth_all_perfis"        ON perfis_acesso        FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='motoboys'             AND policyname='auth_all_motoboys')      THEN CREATE POLICY "auth_all_motoboys"      ON motoboys             FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cupons'               AND policyname='auth_all_cupons')        THEN CREATE POLICY "auth_all_cupons"        ON cupons               FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inventario'           AND policyname='auth_all_inventario')    THEN CREATE POLICY "auth_all_inventario"    ON inventario           FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inventario_movimentos'AND policyname='auth_all_inv_mov')       THEN CREATE POLICY "auth_all_inv_mov"       ON inventario_movimentos FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='movimentacoes_caixa'  AND policyname='auth_all_caixa')         THEN CREATE POLICY "auth_all_caixa"         ON movimentacoes_caixa  FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='sessoes_caixa'        AND policyname='gestor_ve_tudo')         THEN CREATE POLICY "gestor_ve_tudo"         ON sessoes_caixa        FOR ALL USING (true); END IF;

  -- ── Assinaturas ─────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='assinaturas'          AND policyname='leitura_assinatura')     THEN CREATE POLICY "leitura_assinatura"     ON public.assinaturas           FOR SELECT USING (auth.role() = 'authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='assinatura_pagamentos'AND policyname='leitura_pagamentos')     THEN CREATE POLICY "leitura_pagamentos"     ON public.assinatura_pagamentos FOR SELECT USING (auth.role() = 'authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='assinaturas'          AND policyname='escrita_assinatura')     THEN CREATE POLICY "escrita_assinatura"     ON public.assinaturas           FOR ALL    USING (auth.role() = 'authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='assinatura_pagamentos'AND policyname='escrita_pagamentos')     THEN CREATE POLICY "escrita_pagamentos"     ON public.assinatura_pagamentos FOR ALL    USING (auth.role() = 'authenticated'); END IF;

  -- ── Filiais ─────────────────────────────────────────────────────────
  DROP POLICY IF EXISTS "filiais_select_auth"   ON filiais;
  DROP POLICY IF EXISTS "filiais_select_anon"   ON filiais;
  DROP POLICY IF EXISTS "filiais_insert_master" ON filiais;
  DROP POLICY IF EXISTS "filiais_update_master" ON filiais;
  DROP POLICY IF EXISTS "filiais_delete_master" ON filiais;
  CREATE POLICY "filiais_select_auth"   ON filiais FOR SELECT TO authenticated USING (TRUE);
  CREATE POLICY "filiais_select_anon"   ON filiais FOR SELECT TO anon USING (status = 'ativa');
  CREATE POLICY "filiais_insert_master" ON filiais FOR INSERT TO authenticated WITH CHECK (get_my_role() = 'adminMaster');
  CREATE POLICY "filiais_update_master" ON filiais FOR UPDATE TO authenticated USING (get_my_role() = 'adminMaster');
  CREATE POLICY "filiais_delete_master" ON filiais FOR DELETE TO authenticated USING (get_my_role() = 'adminMaster');

  -- ── Perfis (multi-filial) ────────────────────────────────────────────
  DROP POLICY IF EXISTS "perfis_select" ON perfis;
  DROP POLICY IF EXISTS "perfis_insert" ON perfis;
  DROP POLICY IF EXISTS "perfis_update" ON perfis;
  CREATE POLICY "perfis_select" ON perfis FOR SELECT TO authenticated USING (usuario_id = auth.uid() OR get_my_role() = 'adminMaster' OR (get_my_role() = 'gerente' AND filial_id = get_my_filial_id()));
  CREATE POLICY "perfis_insert" ON perfis FOR INSERT TO authenticated WITH CHECK (usuario_id = auth.uid() OR get_my_role() = 'adminMaster');
  CREATE POLICY "perfis_update" ON perfis FOR UPDATE TO authenticated USING (usuario_id = auth.uid() OR get_my_role() = 'adminMaster' OR (get_my_role() = 'gerente' AND filial_id = get_my_filial_id()));

  -- ── Contratos ─────────────────────────────────────────────────────────
  DROP POLICY IF EXISTS "contratos_select" ON contratos_aceites;
  DROP POLICY IF EXISTS "contratos_insert" ON contratos_aceites;
  CREATE POLICY "contratos_select" ON contratos_aceites FOR SELECT TO authenticated USING (usuario_id = auth.uid() OR get_my_role() = 'adminMaster');
  CREATE POLICY "contratos_insert" ON contratos_aceites FOR INSERT TO authenticated WITH CHECK (usuario_id = auth.uid());

  -- ── CRM / Cashback / Fichas ─────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='insumos'           AND policyname='auth_all_access') THEN CREATE POLICY "auth_all_access" ON insumos           FOR ALL TO authenticated USING (true) WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='fichas_tecnicas'   AND policyname='auth_all_access') THEN CREATE POLICY "auth_all_access" ON fichas_tecnicas    FOR ALL TO authenticated USING (true) WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='ficha_itens'       AND policyname='auth_all_access') THEN CREATE POLICY "auth_all_access" ON ficha_itens        FOR ALL TO authenticated USING (true) WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='clientes'          AND policyname='auth_all_access') THEN CREATE POLICY "auth_all_access" ON clientes           FOR ALL TO authenticated USING (true) WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cashback_transacoes'AND policyname='auth_all_access') THEN CREATE POLICY "auth_all_access" ON cashback_transacoes FOR ALL TO authenticated USING (true) WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='planos_mensalistas' AND policyname='Authenticated planos')   THEN CREATE POLICY "Authenticated planos"   ON planos_mensalistas  FOR ALL TO authenticated USING (true) WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='mensalista_entregas'AND policyname='Authenticated entregas') THEN CREATE POLICY "Authenticated entregas" ON mensalista_entregas FOR ALL TO authenticated USING (true) WITH CHECK (true); END IF;

END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- §17  STORAGE — bucket "produtos"
--      Crie o bucket MANUALMENTE: Dashboard → Storage → New Bucket
--      Nome: produtos | Public: ON
--      Depois rode as policies abaixo:
-- ═══════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='produtos_public_read') THEN
    CREATE POLICY "produtos_public_read"  ON storage.objects FOR SELECT              USING  (bucket_id = 'produtos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='produtos_auth_insert') THEN
    CREATE POLICY "produtos_auth_insert"  ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'produtos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='produtos_auth_update') THEN
    CREATE POLICY "produtos_auth_update"  ON storage.objects FOR UPDATE TO authenticated USING  (bucket_id = 'produtos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='produtos_auth_delete') THEN
    CREATE POLICY "produtos_auth_delete"  ON storage.objects FOR DELETE TO authenticated USING  (bucket_id = 'produtos');
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- §18  REALTIME
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'pedidos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE pedidos;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'assinaturas'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE assinaturas;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- §19  SEEDS OBRIGATÓRIOS
-- ═══════════════════════════════════════════════════════════════════════

-- Linha única de configurações
INSERT INTO configuracoes (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Assinatura padrão do tenant
INSERT INTO public.assinaturas (tenant_nome, tipo_vencimento, dia_vencimento, dias_carencia)
SELECT 'Loja Principal', 'dia_util', 5, 5
WHERE NOT EXISTS (SELECT 1 FROM public.assinaturas LIMIT 1);

-- Para promover um usuário a adminMaster, descomente e ajuste:
-- UPDATE perfis_acesso SET cargo = 'adminMaster' WHERE email = 'seu@email.com';


-- ═══════════════════════════════════════════════════════════════════════
-- §20  VERIFICAÇÕES FINAIS
-- ═══════════════════════════════════════════════════════════════════════

-- Tabelas principais
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

-- Assinatura ativa
SELECT id, tenant_nome, tipo_vencimento, dia_vencimento, dias_carencia,
       ultimo_pagamento_em, bloqueado
FROM public.assinaturas;

-- Produtos com código de barras
SELECT COUNT(*) AS produtos_com_barcode
FROM public.produtos
WHERE codigo_barras IS NOT NULL AND codigo_barras <> '';

-- Verificação de policies
-- SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname='public' ORDER BY tablename;

-- ═══════════════════════════════════════════════════════════════════════
--  FIM DO SCHEMA COMPLETO
--  Execute novamente a qualquer momento — todas as operações são
--  idempotentes (CREATE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
--  ON CONFLICT DO NOTHING, DROP + CREATE para triggers/functions).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE clientes
  ADD COLUMN nascimento DATE;

  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE INDEX IF NOT EXISTS idx_pedidos_idempotency ON pedidos(idempotency_key) WHERE idempotency_key IS NOT NULL;