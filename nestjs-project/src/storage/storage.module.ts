import { Global, Module, OnModuleInit } from '@nestjs/common';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule implements OnModuleInit {
  constructor(private readonly storageService: StorageService) {}

  async onModuleInit(): Promise<void> {
    await this.storageService.ensureBuckets();
  }
}
