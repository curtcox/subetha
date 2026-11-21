# HTTP/1.1 → HTTP/2 relay for APNs. No dependencies, no Apple credentials.
#
#   docker build -t subetha-apns-relay gateways/apns-relay
#   docker run -d -p 8080:8080 -e RELAY_SECRET=$(openssl rand -hex 24) subetha-apns-relay
#
# For development builds of the iOS app, add -e APNS_UPSTREAM=https://api.sandbox.push.apple.com.
FROM node:22-slim
WORKDIR /app
COPY src ./src
COPY package.json ./
USER node
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/main.ts"]
