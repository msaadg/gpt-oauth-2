const { onRequest } = require('firebase-functions/v2/https');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const { withAccelerate } = require('@prisma/extension-accelerate');
const Stripe = require('stripe');

require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const JWT_SECRET = process.env.JWT_SECRET;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const DATABASE_URL = process.env.DATABASE_URL;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL;
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

app.get('/oauth/authorize', (req, res) => {
  const state = req.query.state;
  const scope = ['openid', 'email'];
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=${scope.join(' ')}&state=${state}`;
  res.redirect(authUrl);
});

app.get('/oauth/callback', (req, res) => {
  const { code, state } = req.query;
  if (!code) {
    console.error('Authorization code is missing');
    return res.status(400).json({ error: 'Authorization code is missing' });
  }
  res.json({ code, state });
});

app.post('/oauth/token', async (req, res) => {
  const { code, client_id, client_secret, redirect_uri } = await req.body;
  if (client_id !== CLIENT_ID || client_secret !== CLIENT_SECRET) {
    console.error('Invalid client credentials');
    return res.status(400).json({ error: 'Invalid client credentials' });
  }
  try {
    const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    });
    return res.json(tokenResponse.data);
    const tokenData = await tokenResponse.data;
    const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    return res.json(tokenData);
    // if (!tokenData || !userInfoResponse) {
    //     return res.json({message: "tokenData not found"})
    // }
    const userInfo = await userInfoResponse.data;
    const email = userInfo.email;
    const prisma = new PrismaClient({
      datasources: {
        db: { url: DATABASE_URL },
      },
    }).$extends(withAccelerate());
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: { email, accessToken: tokenData.access_token, lastLogin: new Date(), requestCount: 1 }
      });
    } else {
      await prisma.user.update({
        where: { email },
        data: { accessToken: tokenData.access_token, lastLogin: new Date(), requestCount: user.requestCount + 1 }
      });
    }
    // res.json({
    //   access_token: tokenData.access_token,
    //   token_type: 'bearer',
    //   refresh_token: tokenData.refresh_token,
    //   expires_in: tokenData.expires_in
    // });
    return res.json({
        "access_token": await tokenData.access_token.toString(),
        "token_type": "bearer",
        "expires_in": 90
    });
  } catch (error) {
    console.error('Failed to exchange token:', error.message);
    res.status(400).json({ error: 'Failed to exchange token', details: error.message });
  }
});

app.post('/webhook', async (req, res) => {
  const sig = req.header('stripe-signature');
  const rawBody = req.rawBody;
  let event;
  try {
    event = await Stripe.webhooks.constructEventAsync(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`⚠️  Webhook signature verification failed.`, err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed.' });
  }
  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const prisma = new PrismaClient({
      datasources: {
        db: { url: DATABASE_URL },
      },
    }).$extends(withAccelerate());
    const userId = session.client_reference_id;
    const endOfSubs = new Date();
    endOfSubs.setMonth(endOfSubs.getMonth() + 1);
    await prisma.user.update({
      where: { id: userId },
      data: {
        paidUntil: endOfSubs,
      },
    });
    console.log(`User ${userId} has paid for the month.`);
  }
  return res.status(200).json({ received: true });
});

app.post('/crypto', async (req, res) => {
  const authHeader = req.header("Authorization");
  if (!authHeader) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const userInfo = userInfoResponse.data;
    const email = userInfo.email;
    const prisma = new PrismaClient({
      datasources: {
        db: { url: DATABASE_URL },
      },
    }).$extends(withAccelerate());
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: { email, accessToken: token, lastLogin: new Date(), requestCount: 0 }
      });
    }
    const now = new Date();
    if (user.requestCount < 3) {
      await prisma.user.update({
        where: { email },
        data: { requestCount: { increment: 1 }, lastLogin: now }
      });
      
      // return res.json({ message: 'User is verified' });
      const { symbols, columns } = req.body;

      // Validate the request body
      if (!symbols || !columns || !Array.isArray(symbols.tickers) || !Array.isArray(columns)) {
        return res.status(400).json({ error: 'Invalid request body' });
      }

      // Call TradingView API
      const tradingViewResponse = await axios.post('https://scanner.tradingview.com/crypto/scan', {
        symbols: { tickers: symbols.tickers },
        columns: columns
      });
      const tradingViewData = tradingViewResponse.data;

      // Filter and structure the data
      const requiredData = tradingViewData.data.map(item => {
        const filteredData = {};
        item.d.forEach((value, index) => {
          const column = columns[index];
          if (column) {
            filteredData[column] = value;
          }
        });
        return { symbol: item.s, data: filteredData };
      });

      return res.json(requiredData);
    } else if (user.paidUntil && user.paidUntil > now) {
      await prisma.user.update({
        where: { email },
        data: { requestCount: 0, lastLogin: now }
      });
      
      const { symbols, columns } = req.body;

      // Validate the request body
      if (!symbols || !columns || !Array.isArray(symbols.tickers) || !Array.isArray(columns)) {
        return res.status(400).json({ error: 'Invalid request body' });
      }

      // Call TradingView API
      const tradingViewResponse = await axios.post('https://scanner.tradingview.com/crypto/scan', {
        symbols: { tickers: symbols.tickers },
        columns: columns
      });
      const tradingViewData = tradingViewResponse.data;

      // Filter and structure the data
      const requiredData = tradingViewData.data.map(item => {
        const filteredData = {};
        item.d.forEach((value, index) => {
          const column = columns[index];
          if (column) {
            filteredData[column] = value;
          }
        });
        return { symbol: item.s, data: filteredData };
      });

      return res.json(requiredData);
    } else {
      const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: 'API Request',
              },
              unit_amount: 499,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: STRIPE_SUCCESS_URL,
        cancel_url: STRIPE_CANCEL_URL,
        client_reference_id: user.id,
      });
      return res.json({ error: 'Payment required', stripeSessionUrl: session.url });
    }
  } catch (error) {
    console.error('Failed to verify JWT token:', error.message);
    res.status(401).json({ error: 'Unauthorized', details: error.message });
  }
});

app.get('/cancel', (req, res) => {
  res.send('Payment failed, Please try again from the chat hello from saad');
});

// Export the Express app as a Firebase Cloud Function
exports.newapp = onRequest(app);

