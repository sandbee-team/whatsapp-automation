# KNOWN-BAD FIXTURE (P29a security-scan guard proof) - pins an outdated Node
# base image so trivy's misconfig/image scanners have a real target too. The
# assertion in security-scan.test.ts is on the lockfile HIGH-CVE finding
# (deterministic, no image pull needed); this Dockerfile is a secondary,
# non-asserted signal for the same fixture directory. Never copy this shape
# into a real Dockerfile.
FROM node:16-alpine
WORKDIR /app
COPY package-lock.json .
CMD ["node", "-e", "console.log('fixture only')"]
