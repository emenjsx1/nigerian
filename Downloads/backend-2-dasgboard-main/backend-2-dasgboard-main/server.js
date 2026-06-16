import express from 'express';
import axios from 'axios';
import cors from 'cors';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import multer from 'multer';
import sharp from 'sharp';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Middleware de compatibilidade para chamadas do frontend antigo (Edge Functions)
app.use((req, res, next) => {
  if (req.path.startsWith('/admin-')) {
    const originalUrl = req.originalUrl;
    if (req.path === '/admin-upload-image') {
      req.url = '/api/upload-image';
      req.method = 'POST'; // Garantir que seja POST
    } else if (req.path === '/admin-products') {
      const action = req.query.action;
      const id = req.query.id;
      if (action === 'list') {
        req.url = '/api/products';
        req.method = 'GET';
      } else if (action === 'create') {
        req.url = '/api/products';
        req.method = 'POST';
      } else if (action === 'update' && id) {
        req.url = `/api/products/${id}`;
        req.method = 'PUT';
      } else if (action === 'delete' && id) {
        req.url = `/api/products/${id}`;
        req.method = 'DELETE';
      }
    } else if (req.path === '/admin-users') {
      const id = req.query.id;
      if (id) {
        req.url = `/api/users/${id}`;
        // O frontend geralmente manda PUT ou DELETE pro ID, mantemos o metodo original
      } else {
        req.url = '/api/users';
        req.method = 'GET';
      }
    } else if (req.path === '/admin-orders') {
      req.url = '/api/orders' + req.url.substring(req.path.length);
      req.method = 'GET';
    } else if (req.path === '/admin-stats') {
      req.url = '/api/stats' + req.url.substring(req.path.length);
      req.method = 'GET';
    } else if (req.path === '/admin-integrations' || req.path === '/admin-gateway-credentials') {
      req.url = '/api/integrations' + req.url.substring(req.path.length);
    }
    
    console.log(`🔄 [Proxy Interno] ${req.method} ${originalUrl} -> ${req.url}`);
  }
  next();
});

app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const CHECKOUT_BASE_URL = process.env.CHECKOUT_BASE_URL || 'https://pay.visionpub.online';

// Função para gerar checkout_url único (9 caracteres)
function generateCheckoutUrl() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 9; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Função para gerar order_prefix baseado no nome do produto
function generateOrderPrefix(productName) {
  // Pega as 3 primeiras letras do produto em maiúsculas
  const prefix = productName.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, '');
  return prefix.padEnd(3, 'X'); // Se tiver menos de 3 letras, completa com X
}

// Inicializar Supabase com Service Role (backend pode fazer tudo)
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  db: {
    schema: 'public'
  },
  global: {
    headers: {
      'apikey': supabaseServiceKey
    }
  }
});

console.log('Supabase URL:', supabaseUrl ? '✅' : '❌');
console.log('Supabase Service Key:', (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY) ? '✅' : '⚠️ USANDO ANON KEY (pode dar erro ao salvar!)');
console.log('Payblack API Key:', process.env.CHECKOUT_PAYBLACK_API_KEY ? '✅' : '❌');

// Função para capturar IP real
function getClientIp(req) {
  if (req.headers['cf-connecting-ip']) {
    return req.headers['cf-connecting-ip'];
  }
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    return xff.split(',')[0].trim();
  }
  if (req.headers['x-real-ip']) {
    return req.headers['x-real-ip'];
  }
  return req.connection?.remoteAddress || req.socket?.remoteAddress || null;
}

// Função SHA256
function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Configuração do Nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS_APP,
  },
});

function enviarEmail(destino, assunto, conteudoHTML) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: destino,
    subject: assunto,
    html: conteudoHTML,
  };

  transporter.sendMail(mailOptions, (erro, info) => {
    if (erro) {
      console.error('❌ Erro ao enviar email:', erro);
    } else {
      console.log('📧 Email enviado:', info.response);
    }
  });
}

// Função WhatChimp
async function enviarTemplateWhatChimp(telefone, nomeCliente = '') {
  try {
    const telefoneFormatado = telefone.startsWith('258') ? telefone : `258${telefone.replace(/^0/, '')}`;
    const recoveryOfferUrl = String(process.env.RECOVERY_OFFER_URL || '').trim() || '[link indisponivel]';

    const agora = new Date();
    const limite24h = new Date(agora.getTime() - 24 * 60 * 60 * 1000);

    const { data: enviosExistentes } = await supabase
      .from('whatchimp_envios')
      .select('*')
      .eq('telefone', telefoneFormatado)
      .gte('data_envio', limite24h.toISOString());

    if (enviosExistentes && enviosExistentes.length > 0) {
      console.log('⚠️ Template já enviado nas últimas 24h para:', telefoneFormatado);
      return { status: 'skipped', message: 'Já enviado nas últimas 24h' };
    }

    const response = await axios.post(
      'https://app.whatchimp.com/api/v1/whatsapp/send/template',
      {
        apiToken: process.env.WHATCHIMP_API_TOKEN,
        phone_number_id: process.env.WHATCHIMP_PHONE_NUMBER_ID,
        template_id: process.env.WHATCHIMP_TEMPLATE_ID,
        phone_number: telefoneFormatado
      },
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    console.log('📱 WhatChimp response:', { status: response.status, telefone: telefoneFormatado });

    await supabase.from('whatchimp_envios').insert({
      telefone: telefoneFormatado,
      nome_cliente: nomeCliente,
      data_envio: agora.toISOString(),
      status: 'enviado',
      whatchimp_response: response.data
    });

    console.log('✅ Template WhatChimp enviado para:', telefoneFormatado);
    return response.data;
  } catch (err) {
    console.error('❌ Erro ao enviar template WhatChimp:', err.response?.data || err.message);
    throw err;
  }
}

// Notificações Pushcut
async function notificarPushcut(webhookUrl = process.env.PUSHCUT_WEBHOOK_URL) {
  try {
    const url = String(webhookUrl || '').trim();
    if (!url) {
      console.log('Pushcut nao enviado - webhook nao configurado');
      return;
    }

    await axios.post(url);
    console.log('✅ Pushcut enviado');
  } catch (err) {
    console.error('❌ Erro ao enviar Pushcut:', err.response?.data || err.message);
  }
}

async function notificarPushcutSecundario(webhookUrl = process.env.PUSHCUT_SECONDARY_WEBHOOK_URL) {
  try {
    const url = String(webhookUrl || '').trim();
    if (!url) return;

    await axios.post(url);
    console.log('✅ Segundo Pushcut enviado');
  } catch (err) {
    console.error('❌ Erro ao enviar segundo Pushcut:', err.response?.data || err.message);
  }
}

// Google Sheets
async function adicionarNaPlanilha({ nome, email, phone, metodo, amount, reference, utm_source, utm_medium, utm_campaign, utm_term, utm_content }) {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const spreadsheetId = '1aVQxptqsfoBnLmgury1UdiYlRGBNrwBz7s3-HC9a_bM';

    const dataAtual = new Date().toLocaleString('pt-BR', { timeZone: 'Africa/Maputo' });
    const novaLinha = [[nome, email, phone, metodo, amount, reference, dataAtual, utm_source, utm_medium, utm_campaign, utm_term, utm_content]];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'A1',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: novaLinha,
      },
    });

    console.log('📊 Dados adicionados na planilha');
  } catch (err) {
    console.error('❌ Erro ao adicionar na planilha:', err);
  }
}

// Utmify
async function enviarEventoUtmify(dadosEvento, utmifyToken = null) {
  try {
    // Usar token passado por parâmetro ou fallback para .env
    const token = utmifyToken || process.env.UTMIFY_API_TOKEN;
    if (!token) {
      console.log('Utmify nao enviado - token nao configurado');
      return null;
    }

    const response = await axios.post(
      'https://api.utmify.com.br/api-credentials/orders',
      dadosEvento,
      {
        headers: {
          'x-api-token': token,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('✅ Evento enviado para Utmify:', dadosEvento.status, 'OrderID:', dadosEvento.orderId);
    return response.data;
  } catch (err) {
    console.error('❌ Erro ao enviar evento para Utmify:', err.response?.data || err.message);
    throw err;
  }
}

async function buscarProdutoPorOrderId(orderId) {
  try {
    const { data: products } = await supabase
      .from('products')
      .select('*');

    if (products) {
      for (const product of products) {
        if (orderId.startsWith(product.order_prefix)) {
          return {
            productId: product.checkout_url,
            productName: product.name,
            product: product
          };
        }
      }
    }

    return { productId: "produto-generico", productName: "Produto", product: null };
  } catch (error) {
    console.error('❌ Erro ao buscar produto:', error);
    return { productId: "produto-generico", productName: "Produto", product: null };
  }
}

async function criarEventoPagamentoPendente({ orderId, nome, email, phone, amount, clientIP, utm_source, utm_medium, utm_campaign, utm_term, utm_content }) {
  try {
    const { data: eventoExistente } = await supabase
      .from('utmify_eventos')
      .select('*')
      .eq('order_id', orderId)
      .eq('status', 'waiting_payment')
      .maybeSingle();

    if (eventoExistente) {
      console.log('⚠️ Já existe evento pendente para este OrderID');
      return orderId;
    }

    const valorMZN = parseInt(amount);
    const valorUSD = Math.round((valorMZN / 64) * 100);
    const taxaGateway = Math.round(valorUSD * 0.07);
    const comissaoUsuario = valorUSD - taxaGateway;

    const { productId, productName, product } = await buscarProdutoPorOrderId(orderId);

    // Buscar integrações do produto
    let utmifyToken = null;
    let utmifyEnabled = false;

    if (product && product.id) {
      const { data: integration } = await supabase
        .from('integrations')
        .select('*')
        .eq('product_id', product.id)
        .maybeSingle();

      if (integration && integration.utmify_enabled && integration.utmify_api_token) {
        utmifyToken = integration.utmify_api_token;
        utmifyEnabled = true;
        console.log(`🔑 Usando token Utmify do produto: ${product.name}`);
      }
    }

    // Fallback para token global do .env
    if (!utmifyEnabled && process.env.UTMIFY_API_TOKEN) {
      utmifyToken = process.env.UTMIFY_API_TOKEN;
      console.log('🔑 Usando token Utmify global (.env)');
    }
    const agora = new Date();

    const dadosEvento = {
      orderId,
      platform: "VisionPub",
      paymentMethod: "pix",
      status: "waiting_payment",
      createdAt: agora.toISOString().replace('T', ' ').substring(0, 19),
      approvedDate: null,
      refundedAt: null,
      customer: {
        name: nome || "Cliente",
        email: email || "cliente@exemplo.com",
        phone: phone,
        document: null,
        country: "MZ",
        ip: clientIP || "102.0.0.1"
      },
      products: [{
        id: productId,
        name: productName,
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: valorUSD
      }],
      trackingParameters: {
        utm_source: utm_source || null,
        utm_campaign: utm_campaign || null,
        utm_medium: utm_medium || null,
        utm_content: utm_content || null,
        utm_term: utm_term || null,
        src: null,
        sck: null
      },
      commission: {
        totalPriceInCents: valorUSD,
        gatewayFeeInCents: taxaGateway,
        userCommissionInCents: comissaoUsuario,
        currency: "USD"
      },
      isTest: false
    };

    // Só envia se tiver token (produto ou global)
    if (utmifyToken) {
      await enviarEventoUtmify(dadosEvento, utmifyToken);
    } else {
      console.log('⚠️ Utmify desativado - sem token configurado');
    }

    await supabase.from('utmify_eventos').insert({
      order_id: orderId,
      phone,
      status: 'waiting_payment',
      created_at: agora.toISOString(),
    });

    console.log(`💱 Conversão: ${valorMZN} MZN → ${(valorUSD / 100).toFixed(2)} USD | Produto: ${productName}`);
    return orderId;
  } catch (err) {
    console.error('❌ Erro ao criar evento pendente:', err);
  }
}

async function criarEventoPagamentoAprovado({ orderId, nome, email, phone, amount, clientIP, utm_source, utm_medium, utm_campaign, utm_term, utm_content }) {
  try {
    const agora = new Date();
    const valorMZN = parseInt(amount);
    const valorUSD = Math.round((valorMZN / 64) * 100);
    const taxaGateway = Math.round(valorUSD * 0.07);
    const comissaoUsuario = valorUSD - taxaGateway;

    const { productId, productName, product } = await buscarProdutoPorOrderId(orderId);

    // Buscar integrações do produto
    let utmifyToken = null;
    let utmifyEnabled = false;

    if (product && product.id) {
      const { data: integration } = await supabase
        .from('integrations')
        .select('*')
        .eq('product_id', product.id)
        .maybeSingle();

      if (integration && integration.utmify_enabled && integration.utmify_api_token) {
        utmifyToken = integration.utmify_api_token;
        utmifyEnabled = true;
        console.log(`🔑 Usando token Utmify do produto: ${product.name}`);
      }
    }

    // Fallback para token global do .env
    if (!utmifyEnabled && process.env.UTMIFY_API_TOKEN) {
      utmifyToken = process.env.UTMIFY_API_TOKEN;
      console.log('🔑 Usando token Utmify global (.env)');
    }

    const dadosEvento = {
      orderId,
      platform: "VisionPub",
      paymentMethod: "pix",
      status: "paid",
      createdAt: agora.toISOString().replace('T', ' ').substring(0, 19),
      approvedDate: agora.toISOString().replace('T', ' ').substring(0, 19),
      customer: {
        name: nome || "Cliente",
        email: email || "cliente@exemplo.com",
        phone: phone,
        document: null,
        country: "MZ",
        ip: clientIP || "102.0.0.1"
      },
      products: [{
        id: productId,
        name: productName,
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: valorUSD
      }],
      trackingParameters: {
        utm_source: utm_source || null,
        utm_campaign: utm_campaign || null,
        utm_medium: utm_medium || null,
        utm_content: utm_content || null,
        utm_term: utm_term || null,
        src: null,
        sck: null
      },
      commission: {
        totalPriceInCents: valorUSD,
        gatewayFeeInCents: taxaGateway,
        userCommissionInCents: comissaoUsuario,
        currency: "USD"
      },
      isTest: false
    };

    // Só envia se tiver token (produto ou global)
    if (utmifyToken) {
      await enviarEventoUtmify(dadosEvento, utmifyToken);
    } else {
      console.log('⚠️ Utmify desativado - sem token configurado');
    }

    const { data: eventos } = await supabase
      .from('utmify_eventos')
      .select('*')
      .eq('order_id', orderId);

    if (eventos && eventos.length > 0) {
      await supabase
        .from('utmify_eventos')
        .update({ status: 'paid', approved_at: agora.toISOString() })
        .eq('order_id', orderId);
    }

    console.log(`💱 Conversão: ${valorMZN} MZN → ${(valorUSD / 100).toFixed(2)} USD | Produto: ${productName}`);
  } catch (err) {
    console.error('❌ Erro ao criar evento aprovado:', err);
  }
}

// Mensagem de recuperação
async function enviarMensagemWhatsAppRecuperacao(telefone, nomeCliente = '') {
  try {
    const telefoneFormatado = telefone.startsWith('258') ? telefone : `258${telefone.replace(/^0/, '')}`;

    const mensagem = `⚠️ Olá${nomeCliente ? ' ' + nomeCliente : ''}! Parece que houve um erro na sua tentativa de pagamento…

Mas temos uma notícia boa 🤑

Conseguimos liberar um acesso especial: em vez de pagar 197 MZN, você pode acessar tudo por apenas **97 MZN** (por tempo limitado)!

👉 Finalize aqui agora:
${recoveryOfferUrl}

Se tiver dúvidas, é só responder por aqui. Estamos te esperando!`;

    const zapiRecoveryUrl = String(process.env.ZAPI_RECOVERY_URL || '').trim();
    const zapiRecoveryClientToken = String(process.env.ZAPI_RECOVERY_CLIENT_TOKEN || '').trim();
    if (!zapiRecoveryUrl || !zapiRecoveryClientToken) {
      console.log('Mensagem de recuperacao nao enviada - Z-API de recuperacao nao configurada');
      return;
    }

    await axios.post(
      zapiRecoveryUrl,
      {
        phone: telefoneFormatado,
        message: mensagem
      },
      {
        headers: {
          'Client-Token': zapiRecoveryClientToken
        }
      }
    );

    console.log('✅ Mensagem de recuperação enviada');
  } catch (err) {
    console.error('❌ Erro ao enviar mensagem de recuperação:', err.response?.data || err.message);
  }
}

// API ENDPOINTS

// Listar produtos (protegido)
app.get('/api/products', requireAuth, async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ status: 'ok', products });
  } catch (err) {
    console.error('❌ Erro ao listar produtos:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Criar produto (protegido - apenas admin)
app.post('/api/create-product', requireAuth, requireAdmin, async (req, res) => {
  try {
    const productData = req.body;

    // Gerar checkout_url e order_prefix automaticamente
    const checkoutUrl = generateCheckoutUrl();
    const orderPrefix = generateOrderPrefix(productData.name);

    console.log('📦 Tentando criar produto:', {
      name: productData.name,
      price: productData.price,
      order_prefix: orderPrefix,
      checkout_url: checkoutUrl
    });

    const { data, error } = await supabase
      .from('products')
      .insert({
        name: productData.name,
        description: productData.description || '',
        price: productData.price,
        currency: productData.currency || 'MZN',
        image: productData.image || '',
        banner: productData.banner || '',
        order_prefix: orderPrefix,
        checkout_url: checkoutUrl,
        redirect_url: productData.redirectUrl || '',
        timer_enabled: productData.timer?.enabled || false,
        timer_minutes: productData.timer?.minutes || 10,
        timer_text: productData.timer?.text || '⚠ Esta oferta expira em',
        active: productData.active !== undefined ? productData.active : true,
        user_id: req.user.id
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Erro Supabase ao criar produto:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code
      });
      throw error;
    }

    console.log('✅ Produto criado com sucesso:', data.id);
    res.json({ status: 'ok', product: data, productId: data.id });
  } catch (err) {
    console.error('❌ Erro ao criar produto:', {
      message: err.message,
      details: err.details,
      hint: err.hint,
      code: err.code
    });
    res.status(500).json({
      status: 'error',
      message: err.message,
      details: err.details || 'Verifique se SUPABASE_SERVICE_ROLE_KEY está configurada no .env',
      hint: err.hint
    });
  }
});

// Criar produto (protegido - apenas admin)
app.post('/api/products', requireAuth, requireAdmin, async (req, res) => {
  try {
    const productData = req.body;

    console.log('📦 CRIAR PRODUTO - Banner recebido:', productData.banner ? 'SIM ✅' : 'NÃO ❌');
    console.log('📦 Banner URL:', productData.banner);

    const insertData = {
      name: productData.name,
      description: productData.description || '',
      price: productData.price ?? productData.amountMzn,
      currency: productData.currency || 'MZN',
      image: productData.image ?? productData.imageUrl ?? null,
      banner: productData.banner ?? productData.bannerUrl ?? null,
      order_prefix: productData.orderPrefix || generateCheckoutUrl(),
      checkout_url: productData.checkoutUrl || generateCheckoutUrl(),
      redirect_url: productData.redirectUrl || productData.redirect_url || null,
      timer_enabled: productData.timer?.enabled || false,
      timer_minutes: productData.timer?.minutes || 15,
      timer_text: productData.timer?.text || 'Oferta expira em:',
      active: productData.active !== undefined ? productData.active : true,
      upsell_product_id: productData.upsell_product_id || null,
      downsell_product_id: productData.downsell_product_id || null,
      created_by: req.user.id
    };

    const { data, error } = await supabase
      .from('products')
      .insert(insertData)
      .select()
      .single();

    if (error) throw error;

    res.json({ status: 'ok', product: data });
  } catch (err) {
    console.error('❌ Erro ao criar produto:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Atualizar produto (protegido - apenas admin)
app.put('/api/products/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const productData = req.body;

    console.log('🔄 ATUALIZAR PRODUTO - Banner recebido:', productData.banner !== undefined ? 'SIM ✅' : 'NÃO ❌');
    console.log('🔄 Banner URL:', productData.banner);

    const updateData = {};
    if (productData.name) updateData.name = productData.name;
    if (productData.description !== undefined) updateData.description = productData.description;
    if (productData.price !== undefined || productData.amountMzn !== undefined) updateData.price = productData.price ?? productData.amountMzn;
    if (productData.currency) updateData.currency = productData.currency;
    if (productData.image !== undefined || productData.imageUrl !== undefined) updateData.image = productData.image ?? productData.imageUrl;
    if (productData.banner !== undefined || productData.bannerUrl !== undefined) updateData.banner = productData.banner ?? productData.bannerUrl;
    if (productData.orderPrefix) updateData.order_prefix = productData.orderPrefix;
    if (productData.checkoutUrl) updateData.checkout_url = productData.checkoutUrl;
    if (productData.redirectUrl !== undefined || productData.redirect_url !== undefined) updateData.redirect_url = productData.redirectUrl ?? productData.redirect_url;
    if (productData.timer) {
      updateData.timer_enabled = productData.timer.enabled;
      updateData.timer_minutes = productData.timer.minutes;
      updateData.timer_text = productData.timer.text;
    }
    if (productData.active !== undefined) updateData.active = productData.active;
    if (productData.upsell_product_id !== undefined) updateData.upsell_product_id = productData.upsell_product_id || null;
    if (productData.downsell_product_id !== undefined) updateData.downsell_product_id = productData.downsell_product_id || null;

    console.log('📝 Dados que serão salvos no banco:', JSON.stringify(updateData, null, 2));

    const { data, error } = await supabase
      .from('products')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log('✅ Produto salvo! Banner no banco:', data.banner ? 'SIM ✅' : 'NÃO ❌');

    res.json({ status: 'ok', product: data });
  } catch (err) {
    console.error('❌ Erro ao atualizar produto:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Deletar produto (protegido - apenas admin)
app.delete('/api/products/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ status: 'ok', message: 'Produto excluído com sucesso' });
  } catch (err) {
    console.error('❌ Erro ao excluir produto:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Gerar checkout
app.post('/api/generate-checkout', async (req, res) => {
  try {
    const { productId } = req.body;

    const { data: product, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', productId)
      .single();

    if (error) throw error;

    res.json({
      status: 'ok',
      message: 'Checkout gerado com sucesso',
      checkoutUrl: `${CHECKOUT_BASE_URL}/${product.checkout_url}`
    });
  } catch (err) {
    console.error('❌ Erro ao gerar checkout:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Buscar integrações de um produto (protegido - apenas admin)
app.get('/api/products/:id/integrations', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: integration, error } = await supabase
      .from('integrations')
      .select('*')
      .eq('product_id', id)
      .maybeSingle();

    if (error) throw error;

    res.json({ status: 'ok', integration: integration || null });
  } catch (err) {
    console.error('❌ Erro ao buscar integrações:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Salvar/Atualizar integrações de um produto (protegido - apenas admin)
app.post('/api/products/:id/integrations', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const integrationData = req.body;

    const { data: existingIntegration } = await supabase
      .from('integrations')
      .select('id')
      .eq('product_id', id)
      .maybeSingle();

    let result;

    if (existingIntegration) {
      const { data, error } = await supabase
        .from('integrations')
        .update({
          utmify_enabled: integrationData.utmify_enabled || false,
          utmify_api_token: integrationData.utmify_api_token || '',

          facebook_pixel_enabled: integrationData.facebook_pixel_enabled || false,
          facebook_pixel_id: integrationData.facebook_pixel_id || '',
          facebook_access_token: integrationData.facebook_access_token || '',

          google_sheets_enabled: integrationData.google_sheets_enabled || false,
          google_credentials: integrationData.google_credentials || '',
          google_sheet_id: integrationData.google_sheet_id || '',

          whatchimp_enabled: integrationData.whatchimp_enabled || false,
          whatchimp_api_token: integrationData.whatchimp_api_token || '',
          whatchimp_phone_id: integrationData.whatchimp_phone_id || '',
          whatchimp_template_id: integrationData.whatchimp_template_id || '',

          pushcut_enabled: integrationData.pushcut_enabled || false,
          pushcut_webhook_url: integrationData.pushcut_webhook_url || '',

          email_enabled: integrationData.email_enabled || false,
          email_subject: integrationData.email_subject || 'Obrigado pela sua compra!',
          email_template: integrationData.email_template || '<p>Olá {{nome}},</p>'
        })
        .eq('product_id', id)
        .select()
        .single();

      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await supabase
        .from('integrations')
        .insert({
          product_id: id,
          utmify_enabled: integrationData.utmify_enabled || false,
          utmify_api_token: integrationData.utmify_api_token || '',

          facebook_pixel_enabled: integrationData.facebook_pixel_enabled || false,
          facebook_pixel_id: integrationData.facebook_pixel_id || '',
          facebook_access_token: integrationData.facebook_access_token || '',

          google_sheets_enabled: integrationData.google_sheets_enabled || false,
          google_credentials: integrationData.google_credentials || '',
          google_sheet_id: integrationData.google_sheet_id || '',

          whatchimp_enabled: integrationData.whatchimp_enabled || false,
          whatchimp_api_token: integrationData.whatchimp_api_token || '',
          whatchimp_phone_id: integrationData.whatchimp_phone_id || '',
          whatchimp_template_id: integrationData.whatchimp_template_id || '',

          pushcut_enabled: integrationData.pushcut_enabled || false,
          pushcut_webhook_url: integrationData.pushcut_webhook_url || '',

          email_enabled: integrationData.email_enabled || false,
          email_subject: integrationData.email_subject || 'Obrigado pela sua compra!',
          email_template: integrationData.email_template || '<p>Olá {{nome}},</p>'
        })
        .select()
        .single();

      if (error) throw error;
      result = data;
    }

    console.log('✅ Integrações salvas para produto:', id);
    res.json({ status: 'ok', integration: result });
  } catch (err) {
    console.error('❌ Erro ao salvar integrações:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Buscar produto por ID
app.get('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: product, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;

    if (!product) {
      return res.status(404).json({
        status: 'error',
        message: 'Produto não encontrado'
      });
    }

    res.json({ status: 'ok', product });
  } catch (err) {
    console.error('❌ Erro ao buscar produto:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Buscar produto pelo checkout_url (rota pública para o checkout)
app.get('/api/checkout/:checkout_url', async (req, res) => {
  try {
    const { checkout_url } = req.params;

    const { data: product, error } = await supabase
      .from('products')
      .select('*')
      .eq('checkout_url', checkout_url)
      .eq('active', true)
      .maybeSingle();

    if (error) throw error;

    if (!product) {
      return res.status(404).json({
        status: 'error',
        message: 'Produto não encontrado'
      });
    }

    res.json({ status: 'ok', product });
  } catch (err) {
    console.error('❌ Erro ao buscar produto por checkout_url:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Buscar transações aprovadas (orders) (protegido)
app.put('/api/orders/:id/delivery', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { delivery_status, tracking_code } = req.body;

    const { data, error } = await supabase
      .from('orders')
      .update({
        delivery_status,
        tracking_code
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({ status: 'ok', order: data });
  } catch (err) {
    console.error('❌ Erro ao atualizar delivery:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const { status, limit, product_id, start_date, end_date } = req.query;

    let query = supabase
      .from('orders')
      .select(`
        *,
        products (
          id,
          name,
          price,
          image,
          checkout_url
        )
      `)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    if (product_id) {
      query = query.eq('product_id', product_id);
    }

    // Filtros de data para relatórios diários, semanais, mensais
    if (start_date) {
      query = query.gte('created_at', start_date);
    }

    if (end_date) {
      query = query.lte('created_at', end_date);
    }

    // Limite opcional (só se o frontend especificar)
    if (limit) {
      query = query.limit(parseInt(limit));
    }

    const { data: orders, error } = await query;

    if (error) throw error;

    res.json({ status: 'ok', orders: orders || [] });
  } catch (err) {
    console.error('❌ Erro ao buscar orders:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Buscar transações falhadas (protegido)
app.get('/api/failed-transactions', requireAuth, async (req, res) => {
  try {
    const { limit, start_date, end_date } = req.query;

    let query = supabase
      .from('failed_transactions')
      .select('*')
      .order('created_at', { ascending: false });

    // Filtros de data para relatórios diários, semanais, mensais
    if (start_date) {
      query = query.gte('created_at', start_date);
    }

    if (end_date) {
      query = query.lte('created_at', end_date);
    }

    // Limite opcional (só se o frontend especificar)
    if (limit) {
      query = query.limit(parseInt(limit));
    }

    const { data: failedTransactions, error } = await query;

    if (error) throw error;

    res.json({ status: 'ok', failedTransactions: failedTransactions || [] });
  } catch (err) {
    console.error('❌ Erro ao buscar transações falhadas:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Estatísticas (protegido)
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const { data: products } = await supabase.from('products').select('id');
    const { data: orders } = await supabase.from('orders').select('amount, status');

    const totalProducts = products?.length || 0;
    const paidOrders = orders?.filter(o => o.status === 'paid') || [];
    const totalSales = paidOrders.length;
    const totalRevenue = paidOrders.reduce((sum, o) => sum + Number(o.amount), 0);

    const { data: allOrders } = await supabase
      .from('orders')
      .select('status')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    const conversionRate = allOrders && allOrders.length > 0
      ? Math.round((paidOrders.length / allOrders.length) * 100)
      : 0;

    res.json({
      status: 'ok',
      stats: {
        totalProducts,
        totalSales,
        totalRevenue,
        conversionRate
      }
    });
  } catch (err) {
    console.error('❌ Erro ao buscar estatísticas:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Upload de imagem
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas imagens são permitidas'));
    }
  }
});

app.post('/api/upload-image', requireAuth, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'Nenhuma imagem enviada' });
    }

    const optimizedImage = await sharp(req.file.buffer)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const base64Image = `data:image/jpeg;base64,${optimizedImage.toString('base64')}`;

    res.json({ status: 'ok', imageUrl: base64Image });
  } catch (err) {
    console.error('❌ Erro no upload:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Pagamento
app.post('/api/pagar', async (req, res) => {
  const {
    phone, amount, reference, metodo, email, nome, whatsapp, orderId,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content, fbc, fbp
  } = req.body;

  const clientIP = getClientIp(req);
  console.log('🌐 IP capturado:', clientIP);

  if (!phone || !amount || !reference || !metodo || !orderId) {
    return res.status(400).json({
      status: 'error',
      message: 'phone, amount, reference, metodo e orderId são obrigatórios',
    });
  }

  // Buscar integrações do produto
  let integrations = null;
  try {
    const { product } = await buscarProdutoPorOrderId(orderId);
    if (product && product.id) {
      const { data } = await supabase
        .from('integrations')
        .select('*')
        .eq('product_id', product.id)
        .maybeSingle();

      integrations = data;
      console.log(`🔌 Integrações carregadas para: ${product.name}`);
    }
  } catch (err) {
    console.error('⚠️ Erro ao buscar integrações/produto:', err);
  }

  let productObj = null;
  if (orderId) {
     const res = await buscarProdutoPorOrderId(orderId);
     productObj = res?.product || null;
  }

  let payblackApiKey = process.env.CHECKOUT_PAYBLACK_API_KEY;
  let payoutPhone = undefined;

  if (productObj && productObj.gateway_config) {
     if (productObj.gateway_config.checkoutApiKey) {
        payblackApiKey = productObj.gateway_config.checkoutApiKey;
     } else if (productObj.gateway_config.apiKey) {
        payblackApiKey = productObj.gateway_config.apiKey;
     }

     if (productObj.gateway_config.payoutPhone) {
        payoutPhone = productObj.gateway_config.payoutPhone;
     } else if (productObj.gateway_config.payout_phone) {
        payoutPhone = productObj.gateway_config.payout_phone;
     }
  }

  if (!payblackApiKey) {
    return res.status(500).json({ status: 'error', message: 'API Key não configurada para este produto.' });
  }

  if (metodo !== 'mpesa' && metodo !== 'emola') {
    return res.status(400).json({
      status: 'error',
      message: 'Método inválido. Use mpesa ou emola.',
    });
  }

  const payblackBaseUrl = (process.env.CHECKOUT_PAYBLACK_BASE_URL || 'https://h.paymoz.tech/api/v1/pagamentos').replace(/\/+$/, '');
  
  let url;
  if (metodo === 'emola') {
    url = `${payblackBaseUrl}/emola/c2b/pay/`;
  } else {
    url = `${payblackBaseUrl}/c2b/pay/`;
  }
  
  const msisdn = phone.replace(/\D/g, '').startsWith('258')
    ? phone.replace(/\D/g, '')
    : `258${phone.replace(/\D/g, '').replace(/^0/, '')}`;

  try {
    await criarEventoPagamentoPendente({
      orderId, nome, email, phone, amount, clientIP,
      utm_source, utm_medium, utm_campaign, utm_term, utm_content
    });
  } catch (err) {
    console.error('❌ Erro ao enviar evento pendente:', err);
  }

  try {
    const response = await axios.post(
      url,
      {
        msisdn,
        amount: Number(amount),
        reference: reference.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20).toUpperCase(),
        ...(payoutPhone ? { payout_phone: payoutPhone } : {}),
        ...(metodo === 'emola' && nome ? { nome_cliente: nome } : {})
      },
      {
        headers: {
          Authorization: `ApiKey ${payblackApiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      }
    );

    const isSuccessMessage = String(response.data?.message).toLowerCase().includes('success');
    const payblackSuccess = response.data?.success === true ||
      response.data?.success === 1 ||
      String(response.data?.success).toLowerCase() === 'true' ||
      isSuccessMessage ||
      response.data?.status === 'success';

    if (!payblackSuccess && String(response.data?.code).trim() !== '0') {
      const gatewayMessage = response.data?.message || 'Pagamento recusado pelo gateway';
      const gatewayError = new Error(gatewayMessage);
      gatewayError.response = response;
      throw gatewayError;
    }

    console.log('✅ Pagamento aprovado:', response.data);

    const { productId, product } = await buscarProdutoPorOrderId(orderId);

    console.log('💚 TENTANDO SALVAR TRANSAÇÃO APROVADA NA TABELA ORDERS');
    console.log('💚 Dados:', { orderId, productId: product?.id, phone, amount, metodo, reference, status: 'paid' });

    const { data: paidOrderData, error: paidOrderError } = await supabase.from('orders').insert({
      order_id: orderId,
      product_id: product?.id || null,
      customer_name: nome || '',
      customer_email: email || '',
      customer_phone: phone,
      customer_whatsapp: whatsapp || '',
      amount: amount,
      payment_method: metodo,
      payment_reference: reference,
      status: 'paid',
      client_ip: clientIP,
      utm_source: utm_source || '',
      utm_medium: utm_medium || '',
      utm_campaign: utm_campaign || '',
      utm_term: utm_term || '',
      utm_content: utm_content || '',
      fbp: fbp || '',
      fbc: fbc || '',
      paid_at: new Date().toISOString()
    });

    if (paidOrderError) {
      console.error('💚 ERRO AO SALVAR TRANSAÇÃO APROVADA NA TABELA ORDERS:', paidOrderError);
    } else {
      console.log('✅ TRANSAÇÃO APROVADA SALVA NA TABELA ORDERS COM SUCESSO');
    }

    await criarEventoPagamentoAprovado({
      orderId, nome, email, phone, amount, clientIP,
      utm_source, utm_medium, utm_campaign, utm_term, utm_content
    });

    const fbPixelId = process.env.FB_PIXEL_ID;
    const fbAccessToken = process.env.FB_ACCESS_TOKEN;

    if (fbPixelId && fbAccessToken && email && phone) {
      try {
        const payload = {
          data: [{
            event_name: 'Purchase',
            event_time: Math.floor(Date.now() / 1000),
            action_source: 'website',
            user_data: {
              em: email ? sha256(email.trim().toLowerCase()) : undefined,
              ph: phone ? sha256(phone.replace(/\D/g, '')) : undefined,
              fbp: fbp || undefined,
              fbc: fbc || undefined,
            },
            custom_data: {
              currency: 'MZN',
              value: amount,
            }
          }],
          access_token: fbAccessToken,
          test_event_code: 'TEST10707'
        };

        await axios.post(`https://graph.facebook.com/v19.0/${fbPixelId}/events`, payload);
        console.log('🎯 Evento Facebook enviado');
      } catch (fbErr) {
        console.error('❌ Erro ao enviar evento Facebook:', fbErr.response?.data || fbErr.message);
      }
    }

    const nomeCliente = nome || 'Cliente';

    // Email - só envia se estiver ativado nas integrações
    if (email && integrations?.email_enabled) {
      const assuntoEmail = integrations.email_subject || 'Compra Confirmada!';
      let conteudoEmail = integrations.email_template || `
        <p>Olá {{nome}}, seu pedido foi recebido com sucesso!</p>
        <p>Referência: {{reference}}. Valor: MZN {{amount}}.</p>
        <p>Obrigado pela compra!</p>
      `;

      // Substituir variáveis no template
      conteudoEmail = conteudoEmail
        .replace(/\{\{nome\}\}/g, nomeCliente)
        .replace(/\{\{reference\}\}/g, reference)
        .replace(/\{\{amount\}\}/g, amount);

      enviarEmail(email, assuntoEmail, conteudoEmail);
      console.log('✅ Email enviado via integração configurada');
    } else if (email) {
      console.log('⚠️ Email não enviado - integração desativada');
    }

    // Google Sheets - só envia se estiver ativado
    if (integrations?.google_sheets_enabled && integrations?.google_credentials && integrations?.google_sheet_id) {
      try {
        await adicionarNaPlanilha({
          nome: nomeCliente, email, phone, metodo, amount, reference,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content
        });
        console.log('✅ Dados enviados para Google Sheets');
      } catch (err) {
        console.error('❌ Erro ao adicionar na planilha:', err);
      }
    } else {
      console.log('⚠️ Google Sheets não enviado - integração desativada');
    }

    // WhatChimp - só envia se estiver ativado
    if (integrations?.whatchimp_enabled && integrations?.whatchimp_api_token) {
      try {
        const numeroWhatsApp = whatsapp || phone;
        await enviarTemplateWhatChimp(numeroWhatsApp, nomeCliente);
        console.log('✅ Mensagem enviada via WhatChimp');
      } catch (err) {
        console.error('❌ Erro ao enviar WhatChimp:', err);
      }
    } else {
      console.log('⚠️ WhatChimp não enviado - integração desativada');
    }

    // Z-API WhatsApp - só envia se estiver ativado
    if (integrations?.zapi_enabled && integrations?.zapi_instance_id && integrations?.zapi_token) {
      try {
        const telefoneFormatado = phone.startsWith('258') ? phone : `258${phone.replace(/^0/, '')}`;

        // Usar template customizado ou padrão
        let mensagem = integrations.zapi_message_template || `Olá {{nome}}! 👋\n\nSua transação foi aprovada com sucesso 🛒\n\n📌 Referência: *{{reference}}*\n💰 Valor: *MZN {{amount}}*\n\nObrigado pela sua compra!`;

        // Substituir variáveis no template
        mensagem = mensagem
          .replace(/\{\{nome\}\}/g, nomeCliente)
          .replace(/\{\{reference\}\}/g, reference)
          .replace(/\{\{amount\}\}/g, amount);

        const zapiUrl = `https://api.z-api.io/instances/${integrations.zapi_instance_id}/token/${integrations.zapi_token}/send-text`;

        await axios.post(
          zapiUrl,
          { phone: telefoneFormatado, message: mensagem },
          { headers: { 'Client-Token': integrations.zapi_client_token } }
        );

        console.log('✅ Mensagem enviada via Z-API WhatsApp');
      } catch (err) {
        console.error('❌ Erro ao enviar Z-API:', err.response?.data || err.message);
      }
    } else {
      console.log('⚠️ Z-API não enviado - integração desativada');
    }

    // Pushcut - só envia se estiver ativado
    if (integrations?.pushcut_enabled && integrations?.pushcut_webhook_url) {
      try {
        await notificarPushcut(integrations.pushcut_webhook_url);
        await notificarPushcutSecundario();
        console.log('✅ Notificação Pushcut enviada');
      } catch (err) {
        console.error('❌ Erro ao enviar Pushcut:', err);
      }
    } else {
      console.log('⚠️ Pushcut não enviado - integração desativada');
    }

    res.json({ 
      status: 'ok', 
      payment_status: 'paid',
      data: response.data,
      redirectUrl: product?.redirect_url || product?.success_url || null
    });
  } catch (err) {
    const erroDetalhado = err?.response?.data?.message || err.message || "Erro desconhecido";
    console.error('❌ Erro no pagamento detalhado:', JSON.stringify(err?.response?.data || { message: err.message }, null, 2));
    console.error('❌ Erro no pagamento:', erroDetalhado);

    // Buscar produto para salvar na tabela orders
    let productId = null;
    try {
      const { product } = await buscarProdutoPorOrderId(orderId);
      productId = product?.id || null;
    } catch (e) {
      console.error('⚠️ Erro ao buscar produto:', e);
    }

    // Salvar na tabela orders com status failed
    console.log('🔴 TENTANDO SALVAR TRANSAÇÃO FALHADA NA TABELA ORDERS');
    console.log('🔴 Dados:', { orderId, productId, phone, amount, metodo, reference, status: 'failed' });

    const { data: orderData, error: orderError } = await supabase.from('orders').insert({
      order_id: orderId,
      product_id: productId,
      customer_name: nome || '',
      customer_email: email || '',
      customer_phone: phone,
      customer_whatsapp: whatsapp || '',
      amount: amount,
      payment_method: metodo,
      payment_reference: reference,
      status: 'failed',
      utm_source: utm_source || '',
      utm_medium: utm_medium || '',
      utm_campaign: utm_campaign || '',
      utm_term: utm_term || '',
      utm_content: utm_content || '',
      fbc: fbc || '',
      fbp: fbp || ''
    });

    if (orderError) {
      console.error('🔴 ERRO AO SALVAR NA TABELA ORDERS:', orderError);
    } else {
      console.log('✅ TRANSAÇÃO FALHADA SALVA NA TABELA ORDERS COM SUCESSO');
    }

    // Também salvar na tabela failed_transactions (mantém histórico separado)
    console.log('🔴 TENTANDO SALVAR NA TABELA FAILED_TRANSACTIONS');

    const { data: failedData, error: failedError } = await supabase.from('failed_transactions').insert({
      phone,
      payment_method: metodo,
      reference,
      error_message: erroDetalhado,
      order_id: orderId
    });

    if (failedError) {
      console.error('🔴 ERRO AO SALVAR NA TABELA FAILED_TRANSACTIONS:', failedError);
    } else {
      console.log('✅ TRANSAÇÃO FALHADA SALVA NA TABELA FAILED_TRANSACTIONS COM SUCESSO');
    }

    setTimeout(() => {
      enviarMensagemWhatsAppRecuperacao(phone, nome);
    }, 2 * 60 * 1000);

    res.status(500).json({ status: 'error', message: erroDetalhado });
  }
});

// Token de rastreamento
app.post('/api/create-token', async (req, res) => {
  try {
    const { phone, nome, email, utm_source, utm_medium, utm_campaign, utm_term, utm_content, orderId } = req.body;

    if (!phone) {
      return res.status(400).json({ status: 'error', message: 'Phone é obrigatório' });
    }

    const tokenData = {
      phone, nome: nome || '', email: email || '',
      utm_source: utm_source || '', utm_medium: utm_medium || '',
      utm_campaign: utm_campaign || '', utm_term: utm_term || '',
      utm_content: utm_content || '', orderId: orderId || '',
      created_at: Date.now()
    };

    const token = jwt.sign(tokenData, JWT_SECRET, { expiresIn: '15m' });

    console.log('🔐 Token criado para:', phone);
    res.json({ status: 'ok', token });
  } catch (err) {
    console.error('❌ Erro ao criar token:', err);
    res.status(500).json({ status: 'error', message: 'Erro interno' });
  }
});

// Recuperar token
app.get('/api/get-tracking/:token', async (req, res) => {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({ status: 'error', message: 'Token é obrigatório' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    console.log('🔓 Dados recuperados para:', decoded.phone);
    res.json({ status: 'ok', data: decoded });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ status: 'error', message: 'Token expirado' });
    } else if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ status: 'error', message: 'Token inválido' });
    }

    console.error('❌ Erro ao verificar token:', err);
    res.status(500).json({ status: 'error', message: 'Erro interno' });
  }
});

// ============================================
// AUTENTICAÇÃO E AUTORIZAÇÃO
// ============================================

// Middleware para verificar se usuário está autenticado
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        status: 'error',
        message: 'Token de autenticação não fornecido'
      });
    }

    const token = authHeader.replace('Bearer ', '');

    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({
        status: 'error',
        message: 'Token inválido ou expirado'
      });
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.is_active) {
      return res.status(403).json({
        status: 'error',
        message: 'Usuário inativo ou sem permissão'
      });
    }

    req.user = user;
    req.profile = profile;
    next();
  } catch (err) {
    console.error('❌ Erro na autenticação:', err);
    res.status(401).json({
      status: 'error',
      message: 'Erro ao validar token'
    });
  }
}

// Middleware para verificar se usuário é admin
async function requireAdmin(req, res, next) {
  if (req.profile.role !== 'admin') {
    return res.status(403).json({
      status: 'error',
      message: 'Acesso negado. Apenas administradores podem acessar esta rota.'
    });
  }
  next();
}

// ============================================
// ENDPOINTS DE AUTENTICAÇÃO
// ============================================

// Endpoint TEMPORÁRIO para criar o primeiro admin
// Este endpoint só funciona se NÃO existir nenhum admin
// Depois de criar o primeiro admin, este endpoint retorna 403
app.post('/api/auth/setup-admin', async (req, res) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        status: 'error',
        message: 'Email e senha são obrigatórios'
      });
    }

    // Verificar se já existe admin
    const { data: existingAdmins } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('role', 'admin')
      .limit(1);

    if (existingAdmins && existingAdmins.length > 0) {
      return res.status(403).json({
        status: 'error',
        message: 'Endpoint desativado. Já existe um administrador no sistema.'
      });
    }

    // Criar usuário admin
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: full_name || 'Admin',
        role: 'admin'
      }
    });

    if (error) throw error;

    // Criar perfil admin (caso o trigger não tenha funcionado)
    const { error: profileError } = await supabase
      .from('user_profiles')
      .upsert({
        id: data.user.id,
        email: email,
        full_name: full_name || 'Admin',
        role: 'admin',
        is_active: true
      }, {
        onConflict: 'id'
      });

    if (profileError) {
      console.error('❌ Erro ao criar perfil:', profileError);
    }

    console.log('✅ Primeiro admin criado:', email);
    console.log('⚠️ Endpoint /api/auth/setup-admin agora está DESATIVADO');

    res.json({
      status: 'ok',
      message: 'Administrador criado com sucesso! Este endpoint foi desativado automaticamente.',
      user: {
        id: data.user.id,
        email: data.user.email,
        role: 'admin'
      }
    });
  } catch (err) {
    console.error('❌ Erro ao criar admin:', err);
    res.status(500).json({
      status: 'error',
      message: err.message || 'Erro ao criar administrador'
    });
  }
});

// ============================================
// GERENCIAMENTO DE USUÁRIOS (APENAS ADMIN)
// ============================================

// Criar novo usuário (apenas admin)
app.post('/api/users/create', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, password, full_name, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        status: 'error',
        message: 'Email e senha são obrigatórios'
      });
    }

    const validRoles = ['admin', 'user', 'viewer'];
    const userRole = role && validRoles.includes(role) ? role : 'user';

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: full_name || email.split('@')[0]
      }
    });

    if (error) throw error;

    const { error: profileError } = await supabase
      .from('user_profiles')
      .upsert({
        id: data.user.id,
        email: email,
        full_name: full_name || email.split('@')[0],
        role: userRole,
        is_active: true
      }, {
        onConflict: 'id'
      });

    if (profileError) {
      console.error('❌ Erro ao criar perfil:', profileError);
      throw profileError;
    }

    console.log('✅ Usuário criado:', email, '- Role:', userRole);
    res.status(201).json({
      status: 'ok',
      message: 'Usuário criado com sucesso',
      user: {
        id: data.user.id,
        email: data.user.email,
        full_name: full_name || email.split('@')[0],
        role: userRole,
        is_active: true
      }
    });
  } catch (err) {
    console.error('❌ Erro ao criar usuário:', err);
    res.status(500).json({
      status: 'error',
      message: err.message || 'Erro ao criar usuário'
    });
  }
});

// Listar todos os usuários (apenas admin)
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('user_profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ status: 'ok', users: users || [] });
  } catch (err) {
    console.error('❌ Erro ao listar usuários:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Buscar detalhes de um usuário (apenas admin)
app.get('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: user, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;

    res.json({ status: 'ok', user });
  } catch (err) {
    console.error('❌ Erro ao buscar usuário:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Atualizar usuário (apenas admin)
app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, role, is_active } = req.body;

    const updateData = {};
    if (full_name !== undefined) updateData.full_name = full_name;
    if (role !== undefined) updateData.role = role;
    if (is_active !== undefined) updateData.is_active = is_active;

    const { data: user, error } = await supabase
      .from('user_profiles')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log('✅ Usuário atualizado:', id);
    res.json({ status: 'ok', user });
  } catch (err) {
    console.error('❌ Erro ao atualizar usuário:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Redefinir senha de usuário (apenas admin)
app.post('/api/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { new_password } = req.body;

    if (!new_password || new_password.length < 6) {
      return res.status(400).json({
        status: 'error',
        message: 'Senha deve ter no mínimo 6 caracteres'
      });
    }

    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      password: new_password
    });

    if (error) throw error;

    console.log('✅ Senha redefinida para usuário:', id);
    res.json({
      status: 'ok',
      message: 'Senha redefinida com sucesso'
    });
  } catch (err) {
    console.error('❌ Erro ao redefinir senha:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Ver atividades de um usuário (apenas admin)
app.get('/api/users/:id/activities', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id, name, price, active, created_at')
      .eq('user_id', id)
      .order('created_at', { ascending: false });

    if (productsError) throw productsError;

    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('id, order_id, customer_name, amount, status, created_at')
      .eq('user_id', id)
      .order('created_at', { ascending: false });

    if (ordersError) throw ordersError;

    const { data: integrations, error: integrationsError } = await supabase
      .from('integrations')
      .select('id, product_id, created_at')
      .eq('user_id', id)
      .order('created_at', { ascending: false });

    if (integrationsError) throw integrationsError;

    const totalRevenue = orders
      ?.filter(o => o.status === 'approved' || o.status === 'paid')
      .reduce((sum, o) => sum + parseFloat(o.amount || 0), 0) || 0;

    res.json({
      status: 'ok',
      activities: {
        products: products || [],
        orders: orders || [],
        integrations: integrations || [],
        stats: {
          total_products: products?.length || 0,
          total_orders: orders?.length || 0,
          total_integrations: integrations?.length || 0,
          total_revenue: totalRevenue,
          approved_orders: orders?.filter(o => o.status === 'approved' || o.status === 'paid').length || 0
        }
      }
    });
  } catch (err) {
    console.error('❌ Erro ao buscar atividades:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Deletar usuário (apenas admin)
app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (id === req.user.id) {
      return res.status(400).json({
        status: 'error',
        message: 'Você não pode deletar seu próprio usuário'
      });
    }

    const { error: productsError } = await supabase
      .from('products')
      .delete()
      .eq('user_id', id);

    if (productsError) throw productsError;

    const { error: profileError } = await supabase
      .from('user_profiles')
      .delete()
      .eq('id', id);

    if (profileError) throw profileError;

    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(id);
    if (authError) throw authError;

    console.log('✅ Usuário deletado:', id);
    res.json({
      status: 'ok',
      message: 'Usuário deletado com sucesso'
    });
  } catch (err) {
    console.error('❌ Erro ao deletar usuário:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        status: 'error',
        message: 'Email e senha são obrigatórios'
      });
    }

    // Criar um client temporário com ANON_KEY para autenticação do usuário
    const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
    console.log('🔑 Usando ANON_KEY:', anonKey ? 'Configurada' : 'FALTANDO!');
    console.log('🌐 URL Supabase:', supabaseUrl);

    const authClient = createClient(supabaseUrl, anonKey);

    console.log('🔐 Tentando login com email:', email);
    const { data, error } = await authClient.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      console.error('❌ Erro na autenticação Supabase:', error);
      throw error;
    }

    console.log('✅ Autenticação OK, buscando profile do user:', data.user.id);

    // Agora usar o client com SERVICE_ROLE para buscar o profile (ignora RLS)
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle();

    if (profileError) {
      console.error('❌ Erro ao buscar profile:', profileError);
      return res.status(404).json({
        status: 'error',
        message: 'Erro ao buscar perfil: ' + profileError.message
      });
    }

    if (!profile) {
      console.error('❌ Profile não encontrado para user:', data.user.id);
      return res.status(404).json({
        status: 'error',
        message: 'Perfil de usuário não encontrado'
      });
    }

    console.log('✅ Profile encontrado:', profile.full_name);

    if (!profile.is_active) {
      return res.status(403).json({
        status: 'error',
        message: 'Usuário inativo. Entre em contato com o administrador.'
      });
    }

    console.log('✅ Login realizado:', email);
    res.json({
      status: 'ok',
      message: 'Login realizado com sucesso',
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at
      },
      user: {
        id: data.user.id,
        email: data.user.email
      },
      profile: {
        full_name: profile.full_name,
        avatar_url: profile.avatar_url,
        role: profile.role
      }
    });
  } catch (err) {
    console.error('❌ Erro ao fazer login:', err);
    console.error('❌ Erro detalhado:', {
      message: err.message,
      code: err.code,
      status: err.status,
      details: err.details
    });
    res.status(401).json({
      status: 'error',
      message: err.message || 'Email ou senha incorretos'
    });
  }
});

// Logout
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader.replace('Bearer ', '');

    await supabase.auth.admin.signOut(token);

    console.log('✅ Logout realizado:', req.user.email);
    res.json({
      status: 'ok',
      message: 'Logout realizado com sucesso'
    });
  } catch (err) {
    console.error('❌ Erro ao fazer logout:', err);
    res.status(500).json({
      status: 'error',
      message: 'Erro ao fazer logout'
    });
  }
});

// Buscar perfil do usuário logado
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    res.json({
      status: 'ok',
      user: {
        id: req.user.id,
        email: req.user.email
      },
      profile: {
        full_name: req.profile.full_name,
        avatar_url: req.profile.avatar_url,
        role: req.profile.role,
        is_active: req.profile.is_active
      }
    });
  } catch (err) {
    console.error('❌ Erro ao buscar perfil:', err);
    res.status(500).json({
      status: 'error',
      message: 'Erro ao buscar perfil'
    });
  }
});

// Atualizar perfil do usuário logado
app.put('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const { full_name, avatar_url } = req.body;

    const updateData = {};
    if (full_name !== undefined) updateData.full_name = full_name;
    if (avatar_url !== undefined) updateData.avatar_url = avatar_url;

    const { data, error } = await supabase
      .from('user_profiles')
      .update(updateData)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    console.log('✅ Perfil atualizado:', req.user.email);
    res.json({
      status: 'ok',
      message: 'Perfil atualizado com sucesso',
      profile: data
    });
  } catch (err) {
    console.error('❌ Erro ao atualizar perfil:', err);
    res.status(500).json({
      status: 'error',
      message: 'Erro ao atualizar perfil'
    });
  }
});

// Registro de novo usuário (apenas admin pode criar)
app.post('/api/auth/register', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, password, full_name, role = 'viewer' } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        status: 'error',
        message: 'Email e senha são obrigatórios'
      });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: full_name || '',
        role: role
      }
    });

    if (error) throw error;

    console.log('✅ Usuário criado:', email);
    res.json({
      status: 'ok',
      message: 'Usuário criado com sucesso',
      user: {
        id: data.user.id,
        email: data.user.email
      }
    });
  } catch (err) {
    console.error('❌ Erro ao criar usuário:', err);
    res.status(500).json({
      status: 'error',
      message: err.message || 'Erro ao criar usuário'
    });
  }
});

// Listar usuários (apenas admin)
app.get('/api/auth/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('user_profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      status: 'ok',
      users
    });
  } catch (err) {
    console.error('❌ Erro ao listar usuários:', err);
    res.status(500).json({
      status: 'error',
      message: 'Erro ao listar usuários'
    });
  }
});

// Atualizar usuário (apenas admin)
app.put('/api/auth/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, role, is_active } = req.body;

    const updateData = {};
    if (full_name !== undefined) updateData.full_name = full_name;
    if (role !== undefined) updateData.role = role;
    if (is_active !== undefined) updateData.is_active = is_active;

    const { data, error } = await supabase
      .from('user_profiles')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log('✅ Usuário atualizado:', data.email);
    res.json({
      status: 'ok',
      message: 'Usuário atualizado com sucesso',
      user: data
    });
  } catch (err) {
    console.error('❌ Erro ao atualizar usuário:', err);
    res.status(500).json({
      status: 'error',
      message: 'Erro ao atualizar usuário'
    });
  }
});

// Deletar usuário (apenas admin)
app.delete('/api/auth/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (id === req.user.id) {
      return res.status(400).json({
        status: 'error',
        message: 'Você não pode deletar seu próprio usuário'
      });
    }

    const { error: profileError } = await supabase
      .from('user_profiles')
      .delete()
      .eq('id', id);

    if (profileError) throw profileError;

    const { error: authError } = await supabase.auth.admin.deleteUser(id);

    if (authError) throw authError;

    console.log('✅ Usuário deletado:', id);
    res.json({
      status: 'ok',
      message: 'Usuário deletado com sucesso'
    });
  } catch (err) {
    console.error('❌ Erro ao deletar usuário:', err);
    res.status(500).json({
      status: 'error',
      message: 'Erro ao deletar usuário'
    });
  }
});

// ============================================
// ROTAS DE INTEGRAÇÕES (CRUD COMPLETO)
// ============================================

// Listar integrations do usuário atual (ou todas para admin)
app.get('/api/integrations', requireAuth, async (req, res) => {
  try {
    let query = supabase
      .from('integrations')
      .select(`
        *,
        products (
          id,
          name,
          checkout_url
        )
      `);

    if (req.user.role !== 'admin') {
      query = query.eq('user_id', req.user.id);
    }

    const { data: integrations, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ status: 'ok', integrations: integrations || [] });
  } catch (err) {
    console.error('❌ Erro ao listar integrações:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Buscar integração por ID
app.get('/api/integrations/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: integration, error } = await supabase
      .from('integrations')
      .select(`
        *,
        products (
          id,
          name,
          checkout_url
        )
      `)
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;

    if (!integration) {
      return res.status(404).json({
        status: 'error',
        message: 'Integração não encontrada'
      });
    }

    res.json({ status: 'ok', integration });
  } catch (err) {
    console.error('❌ Erro ao buscar integração:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Criar nova integração
app.post('/api/integrations', requireAuth, async (req, res) => {
  try {
    console.log("📥 Body recebido na integração:", req.body); // <---- AQUI!
    const integrationData = req.body;

    // ⚠️ VALIDAÇÃO CRÍTICA
    if (!integrationData.product_id) {
      return res.status(400).json({
        status: 'error',
        message: 'product_id é obrigatório.'
      });
    }

    const { data: integration, error } = await supabase
      .from('integrations')
      .insert({
        product_id: integrationData.product_id,

        utmify_enabled: integrationData.utmify_enabled ?? false,
        utmify_api_token: integrationData.utmify_api_token ?? '',
        utmify_event_name: integrationData.utmify_event_name ?? 'venda',

        facebook_pixel_enabled: integrationData.facebook_pixel_enabled ?? false,
        facebook_pixel_id: integrationData.facebook_pixel_id ?? '',
        facebook_access_token: integrationData.facebook_access_token ?? '',

        google_sheets_enabled: integrationData.google_sheets_enabled ?? false,
        google_credentials: integrationData.google_credentials ?? '',
        google_sheet_id: integrationData.google_sheet_id ?? '',

        whatchimp_enabled: integrationData.whatchimp_enabled ?? false,
        whatchimp_api_token: integrationData.whatchimp_api_token ?? '',
        whatchimp_phone_id: integrationData.whatchimp_phone_id ?? '',
        whatchimp_template_id: integrationData.whatchimp_template_id ?? '',

        pushcut_enabled: integrationData.pushcut_enabled ?? false,
        pushcut_webhook_url: integrationData.pushcut_webhook_url ?? '',

        email_enabled: integrationData.email_enabled ?? false,
        email_subject: integrationData.email_subject ?? 'Obrigado pela sua compra!',
        email_template: integrationData.email_template ?? '<p>Olá {{nome}},</p>',

        zapi_enabled: integrationData.zapi_enabled ?? false,
        zapi_instance_id: integrationData.zapi_instance_id ?? '',
        zapi_token: integrationData.zapi_token ?? '',
        zapi_client_token: integrationData.zapi_client_token ?? '',
        zapi_message_template: integrationData.zapi_message_template ?? ''
      })
      .select()
      .single();

    if (error) throw error;

    console.log('✅ Integração criada:', integration.id);
    res.status(201).json({ status: 'ok', integration });

  } catch (err) {
    console.error('❌ Erro ao criar integração:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// Atualizar integração
app.put('/api/integrations/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const integrationData = req.body;

    const { data: integration, error } = await supabase
      .from('integrations')
      .update(integrationData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log('✅ Integração atualizada:', id);
    res.json({ status: 'ok', integration });
  } catch (err) {
    console.error('❌ Erro ao atualizar integração:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Deletar integração
app.delete('/api/integrations/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('integrations')
      .delete()
      .eq('id', id);

    if (error) throw error;

    console.log('✅ Integração deletada:', id);
    res.json({ status: 'ok', message: 'Integração deletada com sucesso' });
  } catch (err) {
    console.error('❌ Erro ao deletar integração:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// Rota pública de Signup (Criação de Conta)
app.post('/public-signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
    }

    // Criar o usuário no Auth (sem confirmar email automaticamente se não for desejado)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true // Se não quiser exigir confirmação de email na Vercel
    });

    if (authError) {
      if (authError.message.includes('already registered')) {
        return res.status(400).json({ error: 'Este e-mail já está registado.' });
      }
      return res.status(400).json({ error: authError.message });
    }

    // Criar o perfil do usuário como inativo (pendente)
    const { error: profileError } = await supabase
      .from('user_profiles')
      .insert({
        id: authData.user.id,
        email: email,
        name: name,
        role: 'admin',
        is_active: false // Fica pendente aprovação
      });

    if (profileError) {
      return res.status(400).json({ error: 'Erro ao criar perfil.' });
    }

    res.json({ status: 'ok', message: 'Conta criada com sucesso! Aguarde aprovação.' });
  } catch (err) {
    console.error('Erro no signup:', err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// Rota 404 para API
app.use('/api', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Rota não encontrada',
    path: req.path
  });
});

// Servir Frontend em Produção
app.use(express.static(path.join(__dirname, 'client', 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📦 Ambiente: ${process.env.NODE_ENV || 'development'}`);
});
