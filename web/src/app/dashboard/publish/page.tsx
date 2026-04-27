'use client';

import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardBody,
  CardHeader,
  Button,
  Input,
  Textarea,
  Chip,
  Image,
  Spinner,
  Divider,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from '@nextui-org/react';
import { useAuth } from '@/contexts/AuthContext';
import {
  ArrowLeft,
  Upload,
  X,
  Search,
  Hash,
  Send,
  ImagePlus,
  AlertCircle,
  CheckCircle,
} from 'lucide-react';
import { publisherApi } from '@/lib/api';

interface UploadedImage {
  file_id: string;
  width: number;
  height: number;
  url: string; // Base64 preview URL
}

interface TopicInfo {
  id: string;
  name: string;
  link: string;
  type: string;
}

export default function PublishPage() {
  const router = useRouter();
  const { token } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // 表单状态
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<TopicInfo[]>([]);
  
  // UI状态
  const [isUploading, setIsUploading] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isSearchingTopic, setIsSearchingTopic] = useState(false);
  const [topicKeyword, setTopicKeyword] = useState('');
  const [topicResults, setTopicResults] = useState<TopicInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  
  // 话题搜索弹窗
  const { isOpen: isTopicModalOpen, onOpen: onTopicModalOpen, onClose: onTopicModalClose } = useDisclosure();

  // 上传图片
  const handleImageUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0 || !token) return;
    
    setIsUploading(true);
    setError(null);
    
    try {
      for (const file of Array.from(files)) {
        // 验证文件类型
        if (!file.type.startsWith('image/')) {
          throw new Error(`不支持的文件类型: ${file.name}`);
        }
        
        // 限制图片数量
        if (images.length >= 9) {
          throw new Error('最多上传9张图片');
        }
        
        const result = await publisherApi.uploadImage(token, file);
        setImages(prev => [...prev, result]);
      }
    } catch (err: any) {
      setError(err.message || '上传失败');
    } finally {
      setIsUploading(false);
    }
  }, [token, images.length]);

  // 删除图片
  const handleRemoveImage = useCallback(async (fileId: string) => {
    if (!token) return;
    
    try {
      await publisherApi.deleteImage(token, fileId);
      setImages(prev => prev.filter(img => img.file_id !== fileId));
    } catch (err: any) {
      console.error('删除图片失败:', err);
    }
  }, [token]);

  // 搜索话题
  const handleSearchTopic = useCallback(async () => {
    if (!topicKeyword.trim() || !token) return;
    
    setIsSearchingTopic(true);
    setError(null);
    
    try {
      const result = await publisherApi.searchTopic(token, topicKeyword.trim());
      setTopicResults(result.topics);
    } catch (err: any) {
      setError(err.message || '搜索话题失败');
    } finally {
      setIsSearchingTopic(false);
    }
  }, [token, topicKeyword]);

  // 添加话题
  const handleAddTopic = useCallback((topic: TopicInfo) => {
    if (selectedTopics.find(t => t.id === topic.id)) return;
    if (selectedTopics.length >= 5) {
      setError('最多添加5个话题');
      return;
    }
    setSelectedTopics(prev => [...prev, topic]);
    onTopicModalClose();
  }, [selectedTopics, onTopicModalClose]);

  // 移除话题
  const handleRemoveTopic = useCallback((topicId: string) => {
    setSelectedTopics(prev => prev.filter(t => t.id !== topicId));
  }, []);

  // 发布笔记
  const handlePublish = useCallback(async () => {
    if (!token) return;
    
    // 验证
    if (!title.trim()) {
      setError('请输入标题');
      return;
    }
    if (images.length === 0) {
      setError('请至少上传一张图片');
      return;
    }
    
    setIsPublishing(true);
    setError(null);
    setSuccess(null);
    
    try {
      const result = await publisherApi.publishNote(token, {
        title: title.trim(),
        desc: desc.trim(),
        image_ids: images.map(img => img.file_id),
        topic_ids: selectedTopics.map(t => t.id),
      });
      
      if (result.success) {
        setSuccess(`笔记发布成功！ID: ${result.note_id}`);
        // 清空表单
        setTitle('');
        setDesc('');
        setImages([]);
        setSelectedTopics([]);
      }
    } catch (err: any) {
      setError(err.message || '发布失败');
    } finally {
      setIsPublishing(false);
    }
  }, [token, title, desc, images, selectedTopics]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 p-6">
      <div className="max-w-2xl mx-auto">
        {/* 头部 */}
        <div className="flex items-center gap-4 mb-6">
          <Button
            isIconOnly
            variant="light"
            onPress={() => router.push('/dashboard')}
            className="text-white/70 hover:text-white"
          >
            <ArrowLeft size={20} />
          </Button>
          <h1 className="text-2xl font-bold text-white">发布笔记</h1>
          <Chip color="warning" variant="flat" size="sm">小红书</Chip>
        </div>

        {/* 错误/成功提示 */}
        {error && (
          <Card className="mb-4 bg-danger-50 border border-danger-200">
            <CardBody className="flex-row items-center gap-2 py-3">
              <AlertCircle className="text-danger" size={18} />
              <span className="text-danger text-sm">{error}</span>
            </CardBody>
          </Card>
        )}
        
        {success && (
          <Card className="mb-4 bg-success-50 border border-success-200">
            <CardBody className="flex-row items-center gap-2 py-3">
              <CheckCircle className="text-success" size={18} />
              <span className="text-success text-sm">{success}</span>
            </CardBody>
          </Card>
        )}

        {/* 主表单 */}
        <Card className="bg-white/10 backdrop-blur-md border border-white/20">
          <CardBody className="gap-6 p-6">
            {/* 标题 */}
            <Input
              label="笔记标题"
              placeholder="输入笔记标题（必填）"
              value={title}
              onValueChange={setTitle}
              maxLength={20}
              description={`${title.length}/20`}
              classNames={{
                label: "text-white/70",
                input: "text-white",
                description: "text-white/50",
              }}
            />

            {/* 描述 */}
            <Textarea
              label="笔记内容"
              placeholder="输入笔记内容..."
              value={desc}
              onValueChange={setDesc}
              maxLength={1000}
              minRows={4}
              maxRows={10}
              description={`${desc.length}/1000`}
              classNames={{
                label: "text-white/70",
                input: "text-white",
                description: "text-white/50",
              }}
            />

            <Divider className="bg-white/20" />

            {/* 图片上传 */}
            <div>
              <p className="text-sm text-white/70 mb-3">图片 ({images.length}/9)</p>
              
              <div className="grid grid-cols-3 gap-3">
                {/* 已上传的图片 */}
                {images.map((img) => (
                  <div key={img.file_id} className="relative aspect-square">
                    <Image
                      src={img.url}
                      alt="uploaded"
                      className="w-full h-full object-cover rounded-lg"
                    />
                    <Button
                      isIconOnly
                      size="sm"
                      color="danger"
                      className="absolute top-1 right-1 min-w-6 w-6 h-6"
                      onPress={() => handleRemoveImage(img.file_id)}
                    >
                      <X size={14} />
                    </Button>
                  </div>
                ))}
                
                {/* 上传按钮 */}
                {images.length < 9 && (
                  <div
                    className="aspect-square border-2 border-dashed border-white/30 rounded-lg flex flex-col items-center justify-center cursor-pointer hover:border-white/50 transition-colors"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {isUploading ? (
                      <Spinner size="sm" color="white" />
                    ) : (
                      <>
                        <ImagePlus className="text-white/50 mb-1" size={24} />
                        <span className="text-white/50 text-xs">添加图片</span>
                      </>
                    )}
                  </div>
                )}
              </div>
              
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => handleImageUpload(e.target.files)}
              />
            </div>

            <Divider className="bg-white/20" />

            {/* 话题选择 */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-white/70">话题 ({selectedTopics.length}/5)</p>
                <Button
                  size="sm"
                  variant="flat"
                  startContent={<Hash size={14} />}
                  onPress={onTopicModalOpen}
                  className="text-white/70"
                >
                  添加话题
                </Button>
              </div>
              
              <div className="flex flex-wrap gap-2">
                {selectedTopics.map((topic) => (
                  <Chip
                    key={topic.id}
                    onClose={() => handleRemoveTopic(topic.id)}
                    variant="flat"
                    color="secondary"
                  >
                    #{topic.name}
                  </Chip>
                ))}
                {selectedTopics.length === 0 && (
                  <span className="text-white/40 text-sm">暂无话题</span>
                )}
              </div>
            </div>

            <Divider className="bg-white/20" />

            {/* 发布按钮 */}
            <Button
              color="primary"
              size="lg"
              startContent={!isPublishing && <Send size={18} />}
              onPress={handlePublish}
              isLoading={isPublishing}
              isDisabled={!title.trim() || images.length === 0}
              className="w-full"
            >
              {isPublishing ? '发布中...' : '发布笔记'}
            </Button>
          </CardBody>
        </Card>
      </div>

      {/* 话题搜索弹窗 */}
      <Modal isOpen={isTopicModalOpen} onClose={onTopicModalClose} size="lg">
        <ModalContent className="bg-slate-800 text-white">
          <ModalHeader>搜索话题</ModalHeader>
          <ModalBody>
            <div className="flex gap-2">
              <Input
                placeholder="输入话题关键词"
                value={topicKeyword}
                onValueChange={setTopicKeyword}
                onKeyDown={(e) => e.key === 'Enter' && handleSearchTopic()}
                classNames={{
                  input: "text-white",
                }}
              />
              <Button
                isIconOnly
                color="primary"
                onPress={handleSearchTopic}
                isLoading={isSearchingTopic}
              >
                <Search size={18} />
              </Button>
            </div>
            
            <div className="mt-4 max-h-60 overflow-y-auto">
              {topicResults.length > 0 ? (
                <div className="space-y-2">
                  {topicResults.map((topic) => (
                    <div
                      key={topic.id}
                      className="p-3 rounded-lg bg-white/10 hover:bg-white/20 cursor-pointer transition-colors"
                      onClick={() => handleAddTopic(topic)}
                    >
                      <span className="text-secondary">#{topic.name}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-white/50 py-8">
                  {topicKeyword ? '未找到相关话题' : '输入关键词搜索话题'}
                </p>
              )}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onTopicModalClose}>
              取消
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
