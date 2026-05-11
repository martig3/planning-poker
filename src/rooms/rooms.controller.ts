import {
  Body,
  Controller,
  Get,
  Headers,
  MessageEvent,
  Param,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { map } from 'rxjs/operators';
import { interval, merge, Observable } from 'rxjs';
import { RoomsService } from './rooms.service.js';
import { CreateRoomDto } from './dto/create-room.dto.js';
import { JoinRoomDto, RejoinRoomDto } from './dto/join-room.dto.js';
import { CreateTopicDto } from './dto/create-topic.dto.js';
import { CastVoteDto } from './dto/cast-vote.dto.js';

@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Post()
  createRoom(@Body() dto: CreateRoomDto) {
    return this.rooms.createRoom(dto);
  }

  @Get(':code')
  getRoom(@Param('code') code: string) {
    return this.rooms.getSnapshot(code);
  }

  @Post(':code/join')
  joinRoom(@Param('code') code: string, @Body() dto: JoinRoomDto) {
    return this.rooms.joinRoom(code, dto.name);
  }

  @Post(':code/rejoin')
  rejoinRoom(@Param('code') code: string, @Body() dto: RejoinRoomDto) {
    return this.rooms.rejoinRoom(code, dto.userId, dto.name);
  }

  @Post(':code/topics')
  createTopic(
    @Param('code') code: string,
    @Headers('x-user-id') userId: string,
    @Body() dto: CreateTopicDto,
  ) {
    return this.rooms.createTopic(code, userId, dto.title);
  }

  @Post(':code/votes')
  castVote(
    @Param('code') code: string,
    @Headers('x-user-id') userId: string,
    @Body() dto: CastVoteDto,
  ) {
    return this.rooms.castVote(code, userId, dto.value);
  }

  @Sse(':code/events')
  stream(
    @Param('code') code: string,
    @Query('userId') userId: string,
  ): Observable<MessageEvent> {
    const events$ = this.rooms.listenerStream(code, userId).pipe(
      map((evt) => ({ type: evt.type, data: evt }) as MessageEvent),
    );

    const ping$ = interval(20_000).pipe(
      map(() => ({ type: 'ping', data: { t: Date.now() } }) as MessageEvent),
    );

    return merge(events$, ping$);
  }
}
