import { Test, TestingModule } from "@nestjs/testing";
import { AppModule } from "../../src/app.module";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "fs/promises";
import { HighlightCardService } from "../../src/social-card/highlight-card/highlight-card.service";

const testHighlights = [102, 101, 103];

const folderPath = "dist";

async function testHighlightCards () {
  const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleFixture.createNestApplication();

  await app.init();

  const instance = app.get(HighlightCardService);

  const promises = testHighlights.map(async id => {
    const { svg } = await instance.generateCardBuffer(id);

    if (!existsSync(folderPath)) {
      await mkdir(folderPath);
    }
    await writeFile(`${folderPath}/${id}.svg`, svg);
  });

  // generating sequential: 10.5 seconds, parallel: 4.5 seconds
  await Promise.all(promises);
}

testHighlightCards();