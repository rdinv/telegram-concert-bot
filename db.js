export default {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
  
      if (pathname === "/init") {
        await env.DB.exec(`
          CREATE TABLE IF NOT EXISTS users (
            userId TEXT PRIMARY KEY,
            username TEXT,
            firstName TEXT,
            lastName TEXT,
            subscribedConcerts TEXT,
            subscribedVenues TEXT,
            lastNotifiedConcerts TEXT,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP
          );
        `);
  
        await env.DB.exec(`
          CREATE TABLE IF NOT EXISTS concerts (
            id TEXT PRIMARY KEY,
            title TEXT,
            date TEXT,
            venue TEXT,
            price TEXT,
            poster TEXT,
            subscribers TEXT,
            artists TEXT
          );
        `);
  
        return new Response("Database initialized");
      }
  
      return new Response("Not found", { status: 404 });
    }
  };
  