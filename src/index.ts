import { createAppInstance } from './app';
import { env } from './config/env';

createAppInstance().then((app) => {
  app.listen(env.PORT, () => {
    console.log(`Server running on http://localhost:${env.PORT}`);
  });
}).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
