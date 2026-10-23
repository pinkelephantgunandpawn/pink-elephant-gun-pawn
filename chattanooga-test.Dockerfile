# Isolated dependency-validation image for PR #12. Does NOT start the storefront.
FROM node:24-alpine
WORKDIR /app
COPY pe_site/server/package.json pe_site/server/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY pe_site/server/ ./
RUN npm test
ENV NODE_ENV=production
USER node
EXPOSE 10000
CMD ["node", "-e", "require('node:http').createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({status:'ok',mode:'isolated-dependency-test',supplier_requests:false,orders_enabled:false}));}).listen(process.env.PORT||10000,'0.0.0.0')"]
