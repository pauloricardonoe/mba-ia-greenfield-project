import { Test } from '@nestjs/testing';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with ConfigModule, TypeOrmModule, StorageModule and VideosModule', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
