FROM node:22-alpine
WORKDIR /app
COPY pe_site/server/chattanooga_client.js ./chattanooga_client.js
COPY pe_site/server/chattanooga_inspect.js ./chattanooga_inspect.js
COPY pe_site/server/chattanooga_probe.js ./chattanooga_probe.js
COPY pe_site/server/package.json ./package.json
USER node
EXPOSE 10000
CMD ["node","chattanooga_probe.js"]
