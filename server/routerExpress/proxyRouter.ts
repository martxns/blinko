import express from 'express';
import axios from 'axios';

const proxyRouter = express.Router();

proxyRouter.get('/proxy/tags', async (req, res) => {
  try {
    const targetUrl = req.query.endpoint as string; // Get the endpoint from the query parameter

    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing endpoint parameter' });
    }

    // Forward the request to the target URL
    const response = await axios.get(targetUrl, {
      headers: {
        Authorization: req.headers.authorization || '', // Pass any authorization headers if needed
      },
    });

    res.json(response.data); // Send the response back to the frontend
  } catch (error) {
    console.error('Error in proxy:', error.message);
    res.status(500).json({ error: 'Failed to fetch data from the target endpoint' });
  }
});

// Proxy for embedding
proxyRouter.post('/proxy/embed', async (req, res) => {
  try {
    const targetUrl = req.query.endpoint as string;

    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing endpoint parameter' });
    }

    const response = await axios.post(targetUrl, req.body, {
      headers: {
        Authorization: req.headers.authorization || '',
        'Content-Type': 'application/json',
      },
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error in embedding proxy:', error.message);
    res.status(500).json({ error: 'Failed to process embedding request' });
  }
});

// Proxy for chat completions
proxyRouter.post('/proxy/chat', async (req, res) => {
  try {
    const targetUrl = req.query.endpoint as string;

    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing endpoint parameter' });
    }

    const response = await axios.post(targetUrl, req.body, {
      headers: {
        Authorization: req.headers.authorization || '',
        'Content-Type': 'application/json',
      },
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error in chat proxy:', error.message);
    res.status(500).json({ error: 'Failed to process chat request' });
  }
});

proxyRouter.all('/proxy', async (req, res) => {
  try {
    const targetUrl = req.query.path as string; // Get the full target URL from the query parameter

    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing path parameter' });
    }

    // Validate the user-entered URL
    try {
      new URL(targetUrl);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Forward the request to the target URL
    const response = await axios({
      url: targetUrl,
      method: req.method,
      headers: req.headers,
      data: req.body,
    });

    res.status(response.status).json(response.data); // Send the response back to the frontend
  } catch (error) {
    console.error('Error in proxy:', error.message);
    res.status(500).json({ error: 'Failed to process the request' });
  }
});

const app = express();

app.get('/api/proxy/tags', async (req, res) => {
  const targetEndpoint = req.query.endpoint;

  try {
    const response = await axios.get(targetEndpoint, {
      headers: {
        Authorization: req.headers.authorization || '',
      },
    });
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching data from target endpoint:', error.message);
    res.status(500).json({ error: 'Failed to fetch data from the target endpoint' });
  }
});

export default proxyRouter;