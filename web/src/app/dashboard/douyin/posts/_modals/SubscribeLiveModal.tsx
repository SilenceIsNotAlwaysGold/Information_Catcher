"use client";

import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
} from "@nextui-org/modal";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";

export type SubscribeLiveModalProps = {
  isOpen: boolean;
  onClose: () => void;
  liveRoomUrl: string;
  setLiveRoomUrl: (v: string) => void;
  liveStreamer: string;
  setLiveStreamer: (v: string) => void;
  liveThreshold: string;
  setLiveThreshold: (v: string) => void;
  liveError: string;
  liveBusy: boolean;
  onSubmit: () => void;
};

export default function SubscribeLiveModal({
  isOpen, onClose, liveRoomUrl, setLiveRoomUrl,
  liveStreamer, setLiveStreamer, liveThreshold, setLiveThreshold,
  liveError, liveBusy, onSubmit,
}: SubscribeLiveModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalContent>
        <ModalHeader>订阅抖音直播间</ModalHeader>
        <ModalBody className="space-y-3">
          <p className="text-xs text-default-500">
            支持 <code>https://live.douyin.com/&#123;room_id&#125;</code>。需要先在管理员页配置抖音账号 cookie。
          </p>
          <Input label="直播间 URL" placeholder="https://live.douyin.com/123456789"
            value={liveRoomUrl} onValueChange={setLiveRoomUrl} autoFocus />
          <Input label="主播名（可选）" value={liveStreamer} onValueChange={setLiveStreamer} />
          <Input label="在线人数预警阈值（可选）" type="number" placeholder="例如 1000"
            value={liveThreshold} onValueChange={setLiveThreshold} />
          {liveError && <p className="text-sm text-danger">{liveError}</p>}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>取消</Button>
          <Button color="primary" onPress={onSubmit} isLoading={liveBusy}>订阅</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
