.PHONY: test setup local-up demo

test:
	npm test

setup:
	bash scripts/setup.sh

local-up:
	node src/live.ts

demo:
	node src/demo.ts
