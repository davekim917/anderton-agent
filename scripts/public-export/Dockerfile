# Copybara needs Java 25 and git >= 2.45 (it runs `git init --ref-format`); the host has neither.
FROM eclipse-temurin:25-jre-alpine@sha256:3c0a9084927a221ccd1d007fcaf614465672c0af37aaa834c5184483afe56d61
RUN apk add --no-cache git=2.54.0-r0
ARG COPYBARA_RELEASE=v20261005
ADD --checksum=sha256:e672449e8c1ce99b3ecaddc72afa226d3df3d725777ddb589678f216b21f2d49 \
    https://github.com/google/copybara/releases/download/${COPYBARA_RELEASE}/copybara_deploy.jar /opt/copybara.jar
RUN chmod 0444 /opt/copybara.jar
ENTRYPOINT ["java", "-jar", "/opt/copybara.jar"]
