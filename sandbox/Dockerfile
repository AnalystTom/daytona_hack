# Reversy run snapshot: one Daytona sandbox per run, holding Firstmate, Codex, no-mistakes,
# Forgejo with tea, the preview server and the bridge. Its build context is sandbox/
# (see "Run sandbox snapshot" in README.md).
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

COPY . /opt/reversy/sandbox
RUN /opt/reversy/sandbox/setup.sh

WORKDIR /home/daytona
CMD ["sleep", "infinity"]
